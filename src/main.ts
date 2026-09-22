import { App, Modal, Notice, Plugin, RequestUrlParam, requestUrl, TFile, TFolder } from 'obsidian';
import { marked } from 'marked';
import { ConfluenceVaultUploaderSettingTab, ConfluenceVaultUploaderSettings, DEFAULT_SETTINGS, LogLevel } from './settings';

interface SyncState {
  pageMap: Record<string, string>; // obsidianPath (no ext) → confluencePageId
  pageVersions: Record<string, number>; // pageId → version
  processedFiles: string[]; // Already synced files
  timestamp: number;
}

interface SyncSummary {
  startedAt: number;
  finishedAt: number;
  totalFiles: number;
  succeeded: number;
  failed: number;
  stopped: boolean;
  lastError: string;
}

interface SavedData extends ConfluenceVaultUploaderSettings {
  syncState?: SyncState;
  lastSyncSummary?: SyncSummary;
}

interface ConfluencePageResponse {
  id: string;
  title: string;
  status: string;
  version: { number: number };
  body?: { storage?: { value: string } };
  ancestors?: Array<{ id: string }>;
}

interface ConfluenceSearchResponse {
  results: ConfluencePageResponse[];
  size: number;
}

interface ConfluenceSpacesResponse {
  results: Array<{ id: string; key: string; name: string }>;
}

interface RequestError {
  status?: number;
  message?: string;
  body?: string;
}

type LogEntryLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  time: number;
  level: LogEntryLevel;
  message: string;
}

// Buffers sync activity so it can be inspected from the "Show Confluence sync log" command,
// independent of whether the developer console is open. Errors are always recorded — the
// log level only controls informational/verbose noise — so a sync failure is never invisible.
class SyncLogger {
  private entries: LogEntry[] = [];
  private readonly maxEntries = 1000;

  constructor(private readonly getLevel: () => LogLevel) {}

  info(message: string, verboseOnly = false): void {
    const level = this.getLevel();
    if (level === 'none') return;
    if (verboseOnly && level !== 'verbose') return;
    this.record('info', message);
    console.log(message);
  }

  warn(message: string): void {
    if (this.getLevel() === 'none') return;
    this.record('warn', message);
    console.warn(message);
  }

  error(message: string): void {
    this.record('error', message);
    console.error(message);
  }

  getEntries(): LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }

  private record(level: LogEntryLevel, message: string): void {
    this.entries.push({ time: Date.now(), level, message });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }
}

class SyncStatusModal extends Modal {
  constructor(app: App, private readonly plugin: ConfluenceVaultUploaderPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Confluence sync status' });

    const status = this.plugin.getStatusLines();
    const list = contentEl.createEl('ul', { cls: 'confluence-uploader-status-list' });
    for (const line of status) {
      list.createEl('li', { text: line });
    }

    const actions = contentEl.createDiv({ cls: 'confluence-uploader-modal-actions' });
    const logButton = actions.createEl('button', { text: 'View log' });
    logButton.onclick = () => {
      this.close();
      new SyncLogModal(this.app, this.plugin).open();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class SyncLogModal extends Modal {
  constructor(app: App, private readonly plugin: ConfluenceVaultUploaderPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Confluence sync log' });

    const entries = this.plugin.logger.getEntries();
    const pre = contentEl.createEl('pre', { cls: 'confluence-uploader-log' });
    if (entries.length === 0) {
      pre.setText('No log entries yet. Set the log level to Normal or Verbose in settings to capture sync activity.');
    } else {
      const text = entries
        .map(e => `${new Date(e.time).toLocaleTimeString()} [${e.level.toUpperCase()}] ${e.message}`)
        .join('\n');
      pre.setText(text);
    }

    const actions = contentEl.createDiv({ cls: 'confluence-uploader-modal-actions' });

    const copyButton = actions.createEl('button', { text: 'Copy to clipboard' });
    copyButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent ?? '');
        new Notice('Log copied to clipboard.');
      } catch {
        new Notice('Could not copy log to clipboard.');
      }
    };

    const clearButton = actions.createEl('button', { text: 'Clear log' });
    clearButton.onclick = () => {
      this.plugin.logger.clear();
      new Notice('Log cleared.');
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class ConfluenceVaultUploaderPlugin extends Plugin {
  settings: ConfluenceVaultUploaderSettings = DEFAULT_SETTINGS;
  readonly logger = new SyncLogger(() => this.settings.logLevel);
  private pageCache: Record<string, { id: string; version: number }> = {};
  private pageMap: Record<string, string> = {}; // obsidianPath (no ext) → confluencePageId
  private nameToPath: Record<string, string> = {}; // basename (no ext) → full obsidian path (no ext)
  private pageVersions: Record<string, number> = {}; // pageId → version for updates
  private isSyncing: boolean = false;
  private spaceId: string = '';
  private processedFiles: Set<string> = new Set(); // Track synced files for resumability
  private statusBarEl!: HTMLElement;
  private currentSummary: SyncSummary | null = null;
  private lastSyncSummary: SyncSummary | null = null;
  private lastCheckpointAt: number = 0;
  private currentPhase: string = '';

  async onload() {
    await this.loadSettings();

    const data = (await this.loadData()) as SavedData | null;
    this.lastSyncSummary = data?.lastSyncSummary ?? null;

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('mod-clickable');
    this.statusBarEl.onclick = () => this.openStatusModal();
    this.renderIdleStatusBar();

    this.addCommand({
      id: 'sync-vault-to-confluence',
      name: 'Sync vault to Confluence',
      callback: async () => this.syncVaultToConfluence()
    });

    this.addCommand({
      id: 'stop-sync-confluence',
      name: 'Stop Confluence sync',
      callback: () => this.stopSync()
    });

    this.addCommand({
      id: 'clear-confluence-cache',
      name: 'Clear Confluence sync cache',
      callback: () => this.clearCache()
    });

    this.addCommand({
      id: 'repair-confluence-cache',
      name: 'Repair Confluence sync cache',
      callback: async () => this.repairSyncCache()
    });

    this.addCommand({
      id: 'show-confluence-sync-status',
      name: 'Show Confluence sync status',
      callback: () => this.openStatusModal()
    });

    this.addCommand({
      id: 'show-confluence-sync-log',
      name: 'Show Confluence sync log',
      callback: () => new SyncLogModal(this.app, this).open()
    });

    this.addCommand({
      id: 'update-confluence-links',
      name: 'Update Confluence page links (Phase 2)',
      callback: async () => {
        if (this.isSyncing) {
          new Notice('⚠️ Sync already in progress.');
          return;
        }
        const pageCount = Object.keys(this.pageMap).length;
        if (pageCount === 0) {
          new Notice('⚠️ No synced pages found. Run "Sync vault" first.');
          return;
        }
        this.isSyncing = true;
        new Notice(`🔗 Updating links in ${pageCount} pages...`);
        try {
          await this.updateAllPageLinks();
          await this.saveSyncState();
        } finally {
          this.isSyncing = false;
          this.renderIdleStatusBar();
        }
      }
    });

    this.addSettingTab(new ConfluenceVaultUploaderSettingTab(this.app, this));
  }

  openStatusModal(): void {
    new SyncStatusModal(this.app, this).open();
  }

  getStatusLines(): string[] {
    const lines: string[] = [];
    if (this.isSyncing) {
      lines.push(`State: running (${this.currentPhase || 'starting'})`);
      if (this.currentSummary) {
        lines.push(`Progress: ${this.currentSummary.succeeded + this.currentSummary.failed}/${this.currentSummary.totalFiles || '?'} files processed`);
        lines.push(`Succeeded: ${this.currentSummary.succeeded}, Failed: ${this.currentSummary.failed}`);
      }
    } else {
      lines.push('State: idle');
    }

    lines.push(`Cached page mappings: ${Object.keys(this.pageMap).length}`);
    lines.push(`Log level: ${this.settings.logLevel}`);

    if (this.lastSyncSummary) {
      const s = this.lastSyncSummary;
      const finished = s.finishedAt ? new Date(s.finishedAt).toLocaleString() : 'unknown';
      const durationSec = s.finishedAt && s.startedAt ? Math.round((s.finishedAt - s.startedAt) / 1000) : 0;
      lines.push(`Last sync: ${finished} (${durationSec}s), ${s.stopped ? 'stopped early' : 'completed'}`);
      lines.push(`Last sync result: ${s.succeeded} succeeded, ${s.failed} failed, ${s.totalFiles} total`);
      if (s.lastError) {
        lines.push(`Last error: ${s.lastError}`);
      }
    } else {
      lines.push('Last sync: none yet');
    }

    return lines;
  }

  private renderStatusBar(text: string): void {
    this.statusBarEl?.setText(`Confluence: ${text}`);
  }

  private renderIdleStatusBar(): void {
    if (this.lastSyncSummary && this.lastSyncSummary.finishedAt) {
      const time = new Date(this.lastSyncSummary.finishedAt).toLocaleTimeString();
      const state = this.lastSyncSummary.stopped ? 'stopped' : 'done';
      this.renderStatusBar(`idle (last ${state} ${time} — ${this.lastSyncSummary.succeeded}✓ ${this.lastSyncSummary.failed}✗)`);
    } else {
      this.renderStatusBar('idle');
    }
  }

  private stopSync() {
    if (this.isSyncing) {
      this.isSyncing = false;
      new Notice('⏹️ Stopping sync... finishing current file.');
    } else {
      new Notice('No sync in progress.');
    }
  }

  private async clearCache() {
    this.clearSyncState();
    this.pageCache = {};
    // Persist the cleared state so next run starts fresh
    await this.saveData({ ...this.settings, syncState: null, lastSyncSummary: this.lastSyncSummary });
    new Notice('✅ Confluence sync cache cleared. Next sync will start fresh.');
    this.logger.info('[clearCache] Cleared all sync state and page cache');
  }

  // Validates every cached page mapping against Confluence and removes any that no longer
  // resolve (deleted page, wrong/stale ID, etc). Files whose own page or any ancestor folder
  // page was pruned are queued for re-sync. Safe to run at any time the sync is not active —
  // useful when a sync reports 404s that look like a stale parent-page reference.
  async repairSyncCache(): Promise<void> {
    if (this.isSyncing) {
      new Notice('⚠️ Cannot repair cache while a sync is running. Stop the sync first.');
      return;
    }
    if (!this.validateSettings()) {
      return;
    }

    await this.loadSyncState();

    const entries = Object.entries(this.pageMap);
    if (entries.length === 0) {
      new Notice('No cached page mappings to check.');
      return;
    }

    new Notice(`🔧 Checking ${entries.length} cached page mapping(s)...`);
    this.logger.info(`[Repair cache] Checking ${entries.length} cached page mapping(s)`);

    const validPageMap: Record<string, string> = {};
    const removedKeys: string[] = [];
    let checked = 0;

    for (const [key, pageId] of entries) {
      checked += 1;
      if (checked % 25 === 0 || checked === entries.length) {
        this.renderStatusBar(`repairing cache ${checked}/${entries.length}`);
      }
      try {
        const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
        const response = await this.requestConfluence<ConfluencePageResponse>(url, 'GET');
        if (response?.id) {
          validPageMap[key] = pageId;
        } else {
          removedKeys.push(key);
        }
      } catch {
        removedKeys.push(key);
        this.logger.warn(`[Repair cache] Removing stale mapping: "${key}" → ${pageId} (page not found)`);
      }
    }

    this.pageMap = validPageMap;

    if (removedKeys.length > 0) {
      const removedSet = new Set(removedKeys);
      for (const filePath of Array.from(this.processedFiles)) {
        const fullPath = filePath.replace(/\.md$/, '');
        const parts = fullPath.split('/');
        const touchesRemoved = parts.some((_, i) => removedSet.has(parts.slice(0, i + 1).join('/')));
        if (touchesRemoved) {
          this.processedFiles.delete(filePath);
        }
      }
    }

    await this.saveSyncState();
    this.renderIdleStatusBar();

    const message = `🔧 Cache repair complete: ${Object.keys(validPageMap).length} valid, ${removedKeys.length} stale mapping(s) removed and queued for re-sync.`;
    new Notice(message, 7000);
    this.logger.info(`[Repair cache] ${message}`);
  }

  async syncVaultToConfluence() {
    if (!this.validateSettings()) {
      return;
    }

    if (this.isSyncing) {
      new Notice('⚠️ Sync already in progress. Use "Stop Confluence sync" to cancel.');
      return;
    }

    this.isSyncing = true;
    this.currentPhase = 'starting';
    this.currentSummary = { startedAt: Date.now(), finishedAt: 0, totalFiles: 0, succeeded: 0, failed: 0, stopped: false, lastError: '' };
    this.lastCheckpointAt = Date.now();
    this.renderStatusBar('starting...');

    try {
      await this.runSync(this.currentSummary);
    } catch (rawError) {
      const detail = rawError instanceof Error ? rawError.message : String(rawError);
      this.currentSummary.lastError = detail;
      this.logger.error(`[Confluence Sync] ❌ Sync aborted by an unexpected error: ${detail}`);
      new Notice(`❌ Sync stopped unexpectedly: ${detail}. Progress was saved — rerun "Sync vault to Confluence" to resume.`, 10000);
      try {
        await this.saveSyncState();
      } catch (saveError) {
        this.logger.error(`[Confluence Sync] Also failed to save progress after the error: ${saveError}`);
      }
    } finally {
      this.isSyncing = false;
      this.currentSummary.finishedAt = Date.now();
      this.lastSyncSummary = this.currentSummary;
      await this.saveSyncState();
      this.currentSummary = null;
      this.currentPhase = '';
      this.renderIdleStatusBar();
    }
  }

  private async runSync(summary: SyncSummary) {
    new Notice('🔍 Fetching space information...');
    this.spaceId = await this.getSpaceId();
    if (!this.spaceId) {
      new Notice('❌ Could not find space ID for space key: ' + this.settings.spaceKey);
      return;
    }
    this.logger.info(`[Confluence Sync] Found space ID: ${this.spaceId}`);

    // Load previous sync state if available
    const previousState = await this.loadSyncState();
    if (previousState) {
      const elapsed = Math.round((Date.now() - previousState.timestamp) / 1000);
      new Notice(`📋 Resuming from previous sync (${elapsed}s ago). Validating ${Object.keys(this.pageMap).length} cached pages...`);
      this.logger.info('[Confluence Sync] Resuming from previous state, validating pages');

      // Validate that cached pages still exist
      const validPageMap: Record<string, string> = {};
      for (const [title, pageId] of Object.entries(this.pageMap)) {
        try {
          const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
          const response = await this.requestConfluence<ConfluencePageResponse>(url, 'GET');
          if (response && response.id) {
            validPageMap[title] = pageId;
            this.logger.info(`[Confluence Sync] ✓ Page still exists: ${title}`, true);
          }
        } catch {
          this.logger.warn(`[Confluence Sync] ✗ Page deleted or inaccessible: ${title} (${pageId})`);
          this.processedFiles.delete(title); // Re-sync this file
        }
      }

      this.pageMap = validPageMap;
      if (Object.keys(validPageMap).length < Object.keys(previousState.pageMap).length) {
        const deleted = Object.keys(previousState.pageMap).length - Object.keys(validPageMap).length;
        new Notice(`⚠️ ${deleted} page(s) were deleted in Confluence. They will be recreated.`);
      }
    } else {
      this.clearSyncState();
    }

    let files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) {
      new Notice('❌ No markdown files found in the vault.');
      return;
    }

    // Sort files by path for consistent ordering
    files = files.sort((a, b) => a.path.localeCompare(b.path));

    // Build suffix → full-path map so buildMarkdownBody can expand any [[link]] to its full vault path.
    // We index every suffix of each file path, so both "System Landscape" and
    // "Book-In/Book-In Overview" (relative within a subfolder) resolve to the correct full path.
    this.nameToPath = {};
    for (const f of files) {
      const fullPath = f.path.replace(/\.md$/, '');
      const parts = fullPath.split('/');
      for (let i = parts.length - 1; i >= 0; i--) {
        const suffix = parts.slice(i).join('/');
        if (!this.nameToPath[suffix]) {
          this.nameToPath[suffix] = fullPath;
        }
      }
    }

    this.logger.info(`[Confluence Sync] Starting: ${files.length} total files, ${this.processedFiles.size} already synced`);
    this.pageCache = {};
    let successCount = 0;
    let failureCount = 0;
    const filesToSync = files.filter(f => !this.processedFiles.has(f.path));
    summary.totalFiles = filesToSync.length;
    this.currentPhase = 'syncing files';

    new Notice(`📄 Syncing ${filesToSync.length} file(s)...`);
    for (let i = 0; i < filesToSync.length; i++) {
      if (!this.isSyncing) {
        this.logger.info(`[Confluence Sync] Stopped by user at file ${i + 1}/${filesToSync.length}`);
        summary.stopped = true;
        await this.saveSyncState();
        new Notice(`⏹️ Sync paused. Progress saved. ${successCount} files synced, ${this.processedFiles.size} total.`);
        return;
      }

      const file = filesToSync[i];
      const progress = `(${i + 1}/${filesToSync.length})`;
      this.renderStatusBar(`syncing ${i + 1}/${filesToSync.length} (${failureCount} failed) — ${file.basename}`);
      try {
        this.logger.info(`[Confluence Sync] Processing: ${file.path}`, true);
        new Notice(`⏳ ${progress}: ${file.basename}...`, 2000);
        await this.syncFile(file);
        this.processedFiles.add(file.path);
        successCount += 1;
        summary.succeeded = successCount;
        this.logger.info(`[Confluence Sync] ✅ Success: ${file.path}`);

        if (successCount % 10 === 0 || Date.now() - this.lastCheckpointAt > 15000) {
          await this.saveSyncState();
          this.lastCheckpointAt = Date.now();
        }
      } catch (rawError) {
        const error = rawError as RequestError;
        const status = error.status ?? '';
        const detail = rawError instanceof Error ? rawError.message : String(rawError);
        // Obsidian's RequestUrlError carries the response body in .body (not .message)
        const responseBody = error.body ?? '';
        this.logger.error(`[Confluence Sync] ❌ Failed: ${file.path} | status=${status} | ${detail}`);
        if (responseBody) this.logger.error(`[Confluence Sync] ❌ Response body: ${responseBody.substring(0, 2000)}`);
        failureCount += 1;
        summary.failed = failureCount;
        new Notice(`❌ Failed to sync ${file.basename}: ${detail}`, 5000);
      }
    }

    // Phase 2: Update links in all pages
    if (!this.isSyncing) {
      summary.stopped = true;
      await this.saveSyncState();
      return;
    }
    this.currentPhase = 'updating links';
    new Notice('🔗 Updating links...');
    this.logger.info(`[Confluence Sync] Page map with ${Object.keys(this.pageMap).length} entries`);
    await this.updateAllPageLinks();

    if (!this.isSyncing) {
      // Was stopped during Phase 2 — state already saved inside updateAllPageLinks
      summary.stopped = true;
      return;
    }

    await this.saveSyncState();

    const message = `✅ Confluence sync complete: ${successCount} succeeded, ${failureCount} failed, ${Object.keys(this.pageMap).length} total pages.`;
    new Notice(message, 5000);
    this.logger.info(`[Confluence Sync] ${message}`);
  }

  private async getSpaceId(): Promise<string> {
    const baseUrl = this.getConfluenceBaseUrl();
    const url = `${baseUrl}/api/v2/spaces?keys=${this.settings.spaceKey}&limit=1`;

    const response = await this.requestConfluence<ConfluenceSpacesResponse>(url, 'GET');
    if (response?.results && response.results.length > 0) {
      return response.results[0].id;
    }
    return '';
  }

  async syncFile(file: TFile) {
    if (!this.validateSettings()) {
      throw new Error('Invalid Confluence settings');
    }

    this.logger.info(`[syncFile] Reading: ${file.path}`, true);
    let markdown = await this.app.vault.read(file);
    this.logger.info(`[syncFile] Markdown length (raw): ${markdown.length} chars`, true);

    // Remove YAML frontmatter (between --- markers at start of file)
    markdown = this.removeFrontmatter(markdown);
    this.logger.info(`[syncFile] Markdown length (after frontmatter removal): ${markdown.length} chars`, true);

    if (markdown.length === 0) {
      this.logger.warn(`[syncFile] ⚠️ WARNING: Empty content after frontmatter removal for ${file.path}`);
    } else {
      this.logger.info(`[syncFile] Markdown preview: ${markdown.substring(0, 100)}...`, true);
    }

    const title = file.basename;
    const body = this.buildMarkdownBody(markdown);
    this.logger.info(`[syncFile] Markdown body prepared (representation: ${body.representation})`, true);

    // Underscore files update their parent page, not create new pages
    if (file.basename.startsWith('_')) {
      this.logger.info('[syncFile] Underscore file: updating parent', true);

      if (!file.parent || file.parent.path === '') {
        // Root-level underscore file: update root page
        const rootPageId = this.settings.rootPageId;
        if (rootPageId) {
          await this.updatePageContent(rootPageId, body);
          this.logger.info(`[syncFile] ✅ Updated root page with content from: ${file.path}`, true);
          return;
        }
      } else {
        // Regular folder underscore file: find or create parent folder, then update it
        const parentId = await this.ensureParentPath(file.parent);
        if (parentId) {
          // Register both the folder path and this MOC file path pointing to the same Confluence page,
          // so Phase 2 resolves both [[FolderName]] and [[FolderName/_MOC]] by exact match.
          const folderPath = file.parent.path; // e.g. "02 - Functional Modules"
          const mocPath = file.path.replace(/\.md$/, ''); // e.g. "02 - Functional Modules/_Modules MOC"
          this.pageMap[folderPath] = parentId;
          this.pageMap[mocPath] = parentId;
          await this.updatePageContent(parentId, body);
          this.logger.info(`[syncFile] ✅ Updated parent page with content from: ${file.path}`, true);
          return;
        }
      }
    }

    // Normal files: create new page as child of parent folder
    this.logger.info(`[syncFile] Ensuring parent path for: ${file.parent?.path || 'root'}`, true);
    const parentId = await this.ensureParentPath(file.parent);

    this.logger.info(`[syncFile] Creating/updating page: ${title} (parent: ${parentId || 'root'})`, true);
    const pageId = await this.createOrUpdatePage(title, body, parentId);

    // Register by full obsidian path (no extension) — the key format Phase 2 will look up
    const fullPath = file.path.replace(/\.md$/, ''); // e.g. "01 - Overview/System Landscape"
    this.pageMap[fullPath] = pageId;

    this.logger.info(`[syncFile] ✅ Completed: ${file.path} → Confluence page ${pageId} (parent: ${parentId || 'root'})`, true);
  }

  private removeFrontmatter(markdown: string): string {
    // Normalize CRLF to LF first
    const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Match frontmatter block: --- at start, then any content, then closing ---
    // The closing --- may or may not be followed by a newline
    const stripped = normalized.replace(/^---\n[\s\S]*?\n---\n?/, '');
    // trimStart removes leading whitespace; also strip lone asterisk-only lines (e.g. stray ** )
    return stripped.trimStart().replace(/^\*+\n/, '');
  }

  private async ensureParentPath(folder: TFolder | null): Promise<string> {
    if (!folder) {
      return this.settings.rootPageId || '';
    }

    const folderPath = folder.path;
    if (this.pageCache[folderPath]) {
      return this.pageCache[folderPath].id;
    }

    let parentId = this.settings.rootPageId || '';

    const pathParts = folderPath.split('/').filter(p => p);
    let currentPath = '';

    for (const part of pathParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!this.pageCache[currentPath]) {
        const parentPageId = parentId || this.settings.rootPageId || '';
        const pageId = await this.findOrCreateFolderPage(part, parentPageId);
        this.pageCache[currentPath] = { id: pageId, version: 1 };
        // Register folder by full vault path so Phase 2 resolves [[FolderName]] links exactly
        this.pageMap[currentPath] = pageId;
      }

      parentId = this.pageCache[currentPath].id;
    }

    return parentId;
  }

  private async findOrCreateFolderPage(folderName: string, parentPageId: string): Promise<string> {
    this.logger.info(`[findOrCreateFolderPage] Looking for folder: ${folderName} (parent: ${parentPageId || 'root'})`, true);
    const existing = await this.findPageByTitle(folderName, parentPageId);
    if (existing) {
      this.logger.info(`[findOrCreateFolderPage] Found existing folder: ${folderName} (id: ${existing.id})`, true);
      // Register folder page so Phase 2 can resolve its links
      this.pageMap[folderName] = existing.id;
      return existing.id;
    }

    this.logger.info(`[findOrCreateFolderPage] Creating new folder: ${folderName}`);
    const url = `${this.getConfluenceBaseUrl()}/api/v2/pages`;
    const payload: Record<string, unknown> = {
      spaceId: this.spaceId,
      status: 'current',
      title: folderName,
      body: { value: '', representation: 'storage' }
    };
    if (parentPageId) payload.parentId = parentPageId;

    const response = await this.requestConfluence<ConfluencePageResponse>(url, 'POST', payload);
    this.logger.info(`[findOrCreateFolderPage] Created folder: ${folderName} (id: ${response.id})`);
    // Register folder page so Phase 2 can resolve its links
    this.pageMap[folderName] = response.id;
    return response.id;
  }

  buildMarkdownBody(markdown: string): { value: string; representation: string } {
    // Normalize line endings to LF for consistent regex matching
    markdown = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let processedMarkdown = markdown;

    // Convert task list checkboxes before marked so it never generates <input> elements,
    // which are invalid in Confluence storage format XML and cause HTTP 400.
    processedMarkdown = processedMarkdown.replace(/^(\s*[-*+])\s+\[ \]\s+/gm, '$1 ☐ ');
    processedMarkdown = processedMarkdown.replace(/^(\s*[-*+])\s+\[[xX]\]\s+/gm, '$1 ☑ ');

    // Resolve any Obsidian link (bare name or partial path) to the full vault path.
    // nameToPath contains every suffix of every file path, so both "System Landscape" and
    // "Book-In/Book-In Overview" resolve to their full vault paths.
    const resolveObsidianPath = (name: string): string => {
      const clean = name.trim();
      return this.nameToPath[clean] ?? clean;
    };

    // Convert Obsidian embeds ![[File]] to links — Phase 2 will resolve them to Confluence URLs.
    // Placeholder uses full vault path so Phase 2 lookup is unambiguous.
    processedMarkdown = processedMarkdown.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, name, alt) => {
      const fullPath = resolveObsidianPath(name as string);
      const display = ((alt as string | undefined) || (name as string)).trim();
      return `[${display}](OBSIDIAN_LINK:${fullPath})`;
    });

    // Derive a human-readable display label for a link target.
    // If the target is a _MOC file with no explicit display text, use the parent folder name.
    // e.g. "02 - Functional Modules/_Modules MOC" → "02 - Functional Modules"
    const linkDisplay = (pageName: string, displayText: string | undefined): string => {
      if (displayText) return displayText.trim();
      const parts = pageName.split('/');
      const last = parts[parts.length - 1].trim();
      if (last.startsWith('_') && parts.length > 1) return parts[parts.length - 2].trim();
      return pageName.trim();
    };

    // Convert Obsidian wiki links [[Page Name]] to temporary placeholders.
    // Placeholder uses full vault path so Phase 2 lookup is unambiguous.
    processedMarkdown = processedMarkdown.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (match, pageName, displayText) => {
        const fullPath = resolveObsidianPath(pageName as string);
        const display = linkDisplay(pageName as string, displayText as string | undefined);
        return `[${display}](OBSIDIAN_LINK:${fullPath})`;
      }
    );

    let html = marked.parse(processedMarkdown) as string;

    // Convert code blocks with syntax highlighting to Confluence macro format
    html = html.replace(
      /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
      (match, language, code) => {
        const decoded = (code as string)
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim();
        // Escape ]]> so it doesn't terminate the CDATA section prematurely
        const safe = decoded.replace(/\]\]>/g, ']]]]><![CDATA[>');
        return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${language as string}</ac:parameter><ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>`;
      }
    );

    // Convert plain code blocks (without language)
    html = html.replace(
      /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
      (match, code) => {
        const decoded = (code as string)
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim();
        const safe = decoded.replace(/\]\]>/g, ']]]]><![CDATA[>');
        return `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>`;
      }
    );

    // Convert Obsidian callout blockquotes to Confluence macros.
    // marked turns "> [!tip] Title\n> content" into <blockquote><p>[!tip] Title\ncontent</p></blockquote>
    // We detect that pattern in HTML-space, avoiding marked re-processing the Confluence XML.
    const calloutTypeMap: Record<string, string> = {
      note: 'note', tip: 'tip', info: 'info', important: 'note',
      warning: 'warning', caution: 'warning', attention: 'warning',
      danger: 'warning', error: 'warning',
      success: 'tip', check: 'tip', hint: 'tip',
      question: 'note', faq: 'note', help: 'note',
      quote: 'note', abstract: 'note', summary: 'note',
      todo: 'note', bug: 'warning', example: 'info'
    };
    html = html.replace(
      /<blockquote>\s*<p>\[!(note|tip|warning|info|important|caution|danger|error|success|check|question|quote|abstract|summary|todo|bug|example|faq|help|hint|attention)\]([^\n<]*)(?:\n([\s\S]*?))?<\/p>\s*<\/blockquote>/gi,
      (match, type, titleRaw, bodyRaw) => {
        const macroType = calloutTypeMap[(type as string).toLowerCase()] || 'info';
        const title = (titleRaw as string).trim();
        const titleAttr = title ? ` ac:title="${title}"` : '';
        const body = ((bodyRaw as string | undefined) || '').trim();
        const bodyHtml = body ? `<p>${body}</p>` : '';
        return `\n<ac:structured-macro ac:name="${macroType}"${titleAttr}><ac:rich-text-body>${bodyHtml}</ac:rich-text-body></ac:structured-macro>\n`;
      }
    );

    // Ensure line breaks are XHTML compliant (self-closing)
    html = html.replace(/<br>/g, '<br/>');

    return {
      value: html,
      representation: 'storage'
    };
  }

  async createOrUpdatePage(title: string, body: { value: string; representation: string }, parentPageId: string): Promise<string> {
    this.logger.info(`[createOrUpdatePage] Processing page: ${title} (parent: ${parentPageId || 'root'})`, true);
    const existing = await this.findPageByTitle(title, parentPageId);
    if (existing) {
      this.logger.info(`[createOrUpdatePage] Updating existing page: ${title} (id: ${existing.id}, version: ${existing.version})`, true);
      await this.updatePage(existing.id, existing.version, title, body, parentPageId);
      this.logger.info(`[createOrUpdatePage] ✅ Updated: ${title}`, true);
      return existing.id;
    } else {
      this.logger.info(`[createOrUpdatePage] Creating new page: ${title}`, true);
      const pageId = await this.createPage(title, body, parentPageId);
      this.logger.info(`[createOrUpdatePage] ✅ Created: ${title}`, true);
      return pageId;
    }
  }

  async findPageByTitle(title: string, parentPageId?: string): Promise<{ id: string; version: number } | null> {
    const url = `${this.getConfluenceBaseUrl()}/rest/api/content?title=${encodeURIComponent(title)}&spaceKey=${encodeURIComponent(this.settings.spaceKey)}&expand=version`;

    const response = await this.requestConfluence<ConfluenceSearchResponse>(url, 'GET');
    if (response && response.results && response.results.length > 0) {
      let targetPage = response.results[0];

      if (parentPageId && response.results.length > 1) {
        const childPage = response.results.find(p =>
          p.ancestors?.some(a => a.id === parentPageId)
        );
        if (childPage) {
          targetPage = childPage;
        }
      }

      return {
        id: targetPage.id,
        version: targetPage.version?.number ?? 1
      };
    }

    return null;
  }

  async createPage(title: string, body: { value: string; representation: string }, parentPageId: string): Promise<string> {
    const url = `${this.getConfluenceBaseUrl()}/api/v2/pages`;

    const payload: Record<string, unknown> = {
      spaceId: this.spaceId,
      status: 'current',
      title,
      body
    };

    if (parentPageId) {
      payload.parentId = parentPageId;
    }

    this.logger.info(`[createPage] POST to ${url}`, true);
    this.logger.info(`[createPage] Payload: title="${title}", representation="${body.representation}", bodyLength=${body.value.length}`, true);
    const response = await this.requestConfluence<ConfluencePageResponse>(url, 'POST', payload);
    this.logger.info(`[createPage] ✅ Created page ID: ${response.id}`, true);

    // Track version for future updates
    this.pageVersions[response.id] = response.version.number;

    return response.id;
  }

  async updatePage(pageId: string, currentVersion: number, title: string, body: { value: string; representation: string }, parentPageId: string) {
    const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;

    const payload: Record<string, unknown> = {
      id: pageId,
      status: 'current',
      title,
      body,
      version: {
        number: currentVersion + 1
      }
    };

    if (parentPageId) {
      payload.parentId = parentPageId;
    }

    this.logger.info(`[updatePage] PUT to ${url}`, true);
    this.logger.info(`[updatePage] Payload: title="${title}", version=${currentVersion + 1}, bodyLength=${body.value.length}`, true);
    await this.requestConfluence<ConfluencePageResponse>(url, 'PUT', payload);
    this.logger.info(`[updatePage] ✅ Updated page ID: ${pageId}`, true);
  }

  private async updatePageContent(pageId: string, body: { value: string; representation: string }) {
    try {
      const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
      const pageData = await this.requestConfluence<ConfluencePageResponse>(url, 'GET');

      const payload: Record<string, unknown> = {
        id: pageId,
        status: 'current',
        title: pageData.title,
        body,
        version: {
          number: pageData.version.number + 1
        }
      };

      await this.requestConfluence<ConfluencePageResponse>(url, 'PUT', payload);
      this.logger.info(`[updatePageContent] ✅ Updated content for page ${pageId}`, true);
    } catch (error) {
      this.logger.error(`[updatePageContent] ❌ Failed to update page ${pageId}: ${error}`);
      throw error;
    }
  }

  async requestConfluence<T>(url: string, method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(`${this.settings.username}:${this.settings.apiToken}`)}`
    };

    const requestOptions: RequestUrlParam = {
      url,
      method,
      headers
    };

    if (body) {
      requestOptions.body = JSON.stringify(body);
      this.logger.info(`[requestConfluence] Request body (${method}): ${JSON.stringify(body)}`, true);
    }

    const response = await requestUrl(requestOptions);
    this.logger.info(`[requestConfluence] Response status: ${response.status}`, true);

    if (response.status < 200 || response.status >= 300) {
      let errorMsg = 'Unknown error';
      if (response.text) {
        errorMsg = response.text;
      } else if (response.json) {
        errorMsg = JSON.stringify(response.json);
      }

      this.logger.error(`[requestConfluence] ERROR ${response.status} on ${method} ${url}: ${errorMsg.substring(0, 1000)}`);
      throw new Error(`Confluence request failed (${response.status}): ${errorMsg}`);
    }
    return response.json as T;
  }

  private getConfluenceBaseUrl(): string {
    let url = this.settings.confluenceBaseUrl.trim();
    if (!url.endsWith('/wiki') && !url.includes('/wiki/')) {
      url = url.replace(/\/$/, '') + '/wiki';
    }
    return url.replace(/\/$/, '');
  }

  validateSettings(): boolean {
    const { confluenceBaseUrl, username, apiToken, spaceKey } = this.settings;
    if (!confluenceBaseUrl || !username || !apiToken || !spaceKey) {
      new Notice('Please configure all Confluence settings before syncing.');
      return false;
    }
    return true;
  }

  async loadSettings() {
    const saved = await this.loadData() as Partial<ConfluenceVaultUploaderSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    const data = (await this.loadData()) as SavedData | null;
    await this.saveData({ ...data, ...this.settings });
  }

  private async saveSyncState() {
    const state: SyncState = {
      pageMap: this.pageMap,
      pageVersions: this.pageVersions,
      processedFiles: Array.from(this.processedFiles),
      timestamp: Date.now()
    };
    await this.saveData({ ...this.settings, syncState: state, lastSyncSummary: this.lastSyncSummary });
    this.logger.info(`[Sync State] Saved state with ${Object.keys(this.pageMap).length} pages`, true);
  }

  private async loadSyncState(): Promise<SyncState | null> {
    const data = (await this.loadData()) as SavedData | null;
    if (data?.lastSyncSummary) {
      this.lastSyncSummary = data.lastSyncSummary;
    }
    if (data?.syncState) {
      this.pageMap = data.syncState.pageMap ?? {};
      this.pageVersions = data.syncState.pageVersions ?? {};
      this.processedFiles = new Set(data.syncState.processedFiles ?? []);
      this.logger.info(`[Sync State] Loaded state with ${Object.keys(this.pageMap).length} pages, ${this.processedFiles.size} processed files`, true);
      return data.syncState;
    }
    return null;
  }

  private clearSyncState() {
    this.pageMap = {};
    this.pageVersions = {};
    this.processedFiles = new Set();
    this.logger.info('[Sync State] Cleared sync state', true);
  }

  private async updateAllPageLinks() {
    this.logger.info(`[updateAllPageLinks] Starting phase 2 with ${Object.keys(this.pageMap).length} pages`);
    let updated = 0;
    const total = Object.keys(this.pageMap).length;
    let processed = 0;

    for (const [title, pageId] of Object.entries(this.pageMap)) {
      processed += 1;
      this.renderStatusBar(`updating links ${processed}/${total}`);
      if (!this.isSyncing) {
        this.logger.info('[updateAllPageLinks] Stopped by user');
        await this.saveSyncState();
        new Notice(`⏹️ Link update paused. ${updated} pages updated so far.`);
        return;
      }

      try {
        // Fetch current page content — must request body-format=storage explicitly
        const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}?body-format=storage`;
        const pageData = await this.requestConfluence<ConfluencePageResponse>(url, 'GET');

        // Check stop again after async GET (more responsive)
        if (!this.isSyncing) {
          await this.saveSyncState();
          new Notice(`⏹️ Link update paused. ${updated} pages updated so far.`);
          return;
        }

        if (!pageData.body?.storage?.value) {
          this.logger.info(`[updateAllPageLinks] Page ${title} (${pageId}) has no body, skipping`, true);
          continue;
        }

        let content = pageData.body.storage.value;
        let hasLinks = false;

        // Exact lookup by full obsidian path — no heuristics needed because placeholders
        // already carry the full path (set during Phase 1 buildMarkdownBody via nameToPath).
        const resolveLink = (obsidianPath: string): string | null => {
          const clean = obsidianPath.trim();
          const id = this.pageMap[clean];
          if (id) return id;
          this.logger.warn(`[updateAllPageLinks] Unresolved link: ${clean}`);
          return null;
        };

        // Build Confluence URL using page ID only — title slug is optional and caused wrong URLs
        // when pageName included a folder path like "08 - Reference/System Messages"
        const buildUrl = (resolvedPageId: string): string => {
          const baseUrl = this.getConfluenceBaseUrl().replace(/\/wiki$/, '');
          return `${baseUrl}/wiki/spaces/${this.settings.spaceKey}/pages/${resolvedPageId}`;
        };

        // Fix previously-generated wrong URLs that included folder path in slug
        // Pattern: /pages/{id}/{segment1}/{segment2} — invalid, fix to /pages/{id}
        const confBase = this.getConfluenceBaseUrl().replace(/\/wiki$/, '');
        const escapedBase = confBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wrongUrlRe = new RegExp(
          `href="${escapedBase}/wiki/spaces/${this.settings.spaceKey}/pages/(\\d+)/[^"/?]+/[^"/?]+"`,
          'g'
        );
        content = content.replace(wrongUrlRe, (match: string, pid: string) => {
          hasLinks = true;
          return `href="${buildUrl(pid)}"`;
        });

        // Replace <a href="OBSIDIAN_LINK:pageName"> (marked parsed single-word links into real <a> tags)
        content = content.replace(/href="OBSIDIAN_LINK:([^"]+)"/g, (match: string, pageName: string) => {
          const pid = resolveLink(pageName);
          if (pid) { hasLinks = true; return `href="${buildUrl(pid)}"`; }
          return match;
        });

        // Replace [text](OBSIDIAN_LINK:pageName) (multi-word links marked left as plain text)
        content = content.replace(/\[([^\]]+)\]\(OBSIDIAN_LINK:([^)]+)\)/g, (match: string, text: string, pageName: string) => {
          const pid = resolveLink(pageName);
          if (pid) { hasLinks = true; return `<a href="${buildUrl(pid)}">${text}</a>`; }
          return match;
        });

        // If links were updated, save the page
        if (hasLinks) {
          const updatePayload: Record<string, unknown> = {
            id: pageId,
            status: 'current',
            title: pageData.title, // use actual Confluence title, not the pageMap key (which is the vault path)
            body: {
              value: content,
              representation: 'storage'
            },
            version: {
              number: pageData.version.number + 1
            }
          };

          const updateUrl = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
          await this.requestConfluence<ConfluencePageResponse>(updateUrl, 'PUT', updatePayload);
          updated++;
          this.logger.info(`[updateAllPageLinks] ✅ Updated links in: ${title}`, true);
        }
      } catch (error) {
        this.logger.error(`[updateAllPageLinks] ❌ Failed to update ${title}: ${error}`);
      }
    }

    new Notice(`🔗 Link update complete: ${updated} pages updated.`, 5000);
    this.logger.info(`[updateAllPageLinks] Phase 2 complete: ${updated} pages updated`);
  }
}
