import { App, Notice, Plugin, requestUrl, TFile, TFolder } from 'obsidian';
import { marked } from 'marked';
import { ConfluenceVaultUploaderSettingTab, ConfluenceVaultUploaderSettings, DEFAULT_SETTINGS } from './settings';

interface SyncState {
  pageMap: Record<string, string>; // title → pageId
  pageVersions: Record<string, number>; // pageId → version
  processedFiles: string[]; // Already synced files
  timestamp: number;
}

export default class ConfluenceVaultUploaderPlugin extends Plugin {
  settings: ConfluenceVaultUploaderSettings = DEFAULT_SETTINGS;
  private pageCache: Record<string, { id: string; version: number }> = {};
  private pageMap: Record<string, string> = {}; // title → pageId mapping for link resolution
  private pageVersions: Record<string, number> = {}; // pageId → version for updates
  private isSyncing: boolean = false;
  private spaceId: string = '';
  private processedFiles: Set<string> = new Set(); // Track synced files for resumability

  async onload() {
    await this.loadSettings();

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
        }
      }
    });

    this.addSettingTab(new ConfluenceVaultUploaderSettingTab(this.app, this));
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
    await this.saveData({ ...this.settings, syncState: null });
    new Notice('✅ Confluence sync cache cleared. Next sync will start fresh.');
    console.log('[clearCache] Cleared all sync state and page cache');
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

    try {
      new Notice('🔍 Fetching space information...');
      this.spaceId = await this.getSpaceId();
      if (!this.spaceId) {
        new Notice('❌ Could not find space ID for space key: ' + this.settings.spaceKey);
        this.isSyncing = false;
        return;
      }
      console.log(`[Confluence Sync] Found space ID: ${this.spaceId}`);

      // Load previous sync state if available
      const previousState = await this.loadSyncState();
      if (previousState) {
        const elapsed = Math.round((Date.now() - previousState.timestamp) / 1000);
        new Notice(`📋 Resuming from previous sync (${elapsed}s ago). Validating ${Object.keys(this.pageMap).length} cached pages...`);
        console.log(`[Confluence Sync] Resuming from previous state, validating pages`);

        // Validate that cached pages still exist
        const validPageMap: Record<string, string> = {};
        for (const [title, pageId] of Object.entries(this.pageMap)) {
          try {
            const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
            const response = await this.requestConfluence(url, 'GET');
            if (response && response.id) {
              validPageMap[title] = pageId;
              console.log(`[Confluence Sync] ✓ Page still exists: ${title}`);
            }
          } catch (error) {
            console.warn(`[Confluence Sync] ✗ Page deleted or inaccessible: ${title} (${pageId})`);
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
        this.isSyncing = false;
        return;
      }

      // Sort files by path for consistent ordering
      files = files.sort((a, b) => a.path.localeCompare(b.path));

      console.log(`[Confluence Sync] Starting: ${files.length} total files, ${this.processedFiles.size} already synced`);
      this.pageCache = {};
      let successCount = 0;
      let failureCount = 0;
      const filesToSync = files.filter(f => !this.processedFiles.has(f.path));

      new Notice(`📄 Syncing ${filesToSync.length} file(s)...`);
      for (let i = 0; i < filesToSync.length; i++) {
        if (!this.isSyncing) {
          console.log(`[Confluence Sync] Stopped by user at file ${i + 1}/${filesToSync.length}`);
          await this.saveSyncState();
          new Notice(`⏹️ Sync paused. Progress saved. ${successCount} files synced, ${this.processedFiles.size} total.`);
          return;
        }

        const file = filesToSync[i];
        const progress = `(${i + 1}/${filesToSync.length})`;
        try {
          console.log(`[Confluence Sync] Processing: ${file.path}`);
          new Notice(`⏳ ${progress}: ${file.basename}...`, 2000);
          await this.syncFile(file);
          this.processedFiles.add(file.path);
          successCount += 1;
          console.log(`[Confluence Sync] ✅ Success: ${file.path}`);

          if (successCount % 10 === 0) {
            await this.saveSyncState();
          }
        } catch (error) {
          console.error(`[Confluence Sync] ❌ Failed: ${file.path}`, error);
          failureCount += 1;
          new Notice(`❌ Failed to sync ${file.basename}: ${error}`, 3000);
        }
      }

      // Phase 2: Update links in all pages
      new Notice('🔗 Updating links...');
      console.log(`[Confluence Sync] Page map with ${Object.keys(this.pageMap).length} entries`);
      await this.updateAllPageLinks();

      await this.saveSyncState();

      const message = `✅ Confluence sync complete: ${successCount} new, ${this.pageMap ? Object.keys(this.pageMap).length : 0} total pages.`;
      new Notice(message, 5000);
      console.log(`[Confluence Sync] ${message}`);
    } finally {
      this.isSyncing = false;
    }
  }

  private async getSpaceId(): Promise<string> {
    const baseUrl = this.getConfluenceBaseUrl();
    const url = `${baseUrl}/api/v2/spaces?keys=${this.settings.spaceKey}&limit=1`;

    const response = await this.requestConfluence(url, 'GET');
    if (response?.results && response.results.length > 0) {
      return response.results[0].id;
    }
    return '';
  }

  async syncFile(file: TFile) {
    if (!this.validateSettings()) {
      throw new Error('Invalid Confluence settings');
    }

    console.log(`[syncFile] Reading: ${file.path}`);
    let markdown = await this.app.vault.read(file);
    console.log(`[syncFile] Markdown length (raw): ${markdown.length} chars`);

    // Remove YAML frontmatter (between --- markers at start of file)
    markdown = this.removeFrontmatter(markdown);
    console.log(`[syncFile] Markdown length (after frontmatter removal): ${markdown.length} chars`);

    if (markdown.length === 0) {
      console.warn(`[syncFile] ⚠️ WARNING: Empty content after frontmatter removal!`);
    } else {
      console.log(`[syncFile] Markdown preview: ${markdown.substring(0, 100)}...`);
    }

    const title = file.basename;
    const body = this.buildMarkdownBody(markdown);
    console.log(`[syncFile] Markdown body prepared (representation: ${body.representation})`);

    // Underscore files update their parent page, not create new pages
    if (file.basename.startsWith('_')) {
      console.log(`[syncFile] Underscore file: updating parent`);

      if (!file.parent || file.parent.path === '') {
        // Root-level underscore file: update root page
        const rootPageId = this.settings.rootPageId;
        if (rootPageId) {
          await this.updatePageContent(rootPageId, body);
          console.log(`[syncFile] ✅ Updated root page with content from: ${file.path}`);
          return;
        }
      } else {
        // Regular folder underscore file: find or create parent folder, then update it
        const parentId = await this.ensureParentPath(file.parent);
        if (parentId) {
          await this.updatePageContent(parentId, body);
          console.log(`[syncFile] ✅ Updated parent page with content from: ${file.path}`);
          return;
        }
      }
    }

    // Normal files: create new page as child of parent folder
    console.log(`[syncFile] Ensuring parent path for: ${file.parent?.path || 'root'}`);
    const parentId = await this.ensureParentPath(file.parent);

    console.log(`[syncFile] Creating/updating page: ${title} (parent: ${parentId || 'root'})`);
    const pageId = await this.createOrUpdatePage(title, body, parentId);

    // Register page in map for link resolution
    this.pageMap[title] = pageId;

    console.log(`[syncFile] ✅ Completed: ${file.path}`);
  }

  private removeFrontmatter(markdown: string): string {
    // Normalize CRLF to LF first
    const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Match frontmatter block: --- at start, then any content, then closing ---
    // The closing --- may or may not be followed by a newline
    const stripped = normalized.replace(/^---\n[\s\S]*?\n---\n?/, '');
    return stripped.trimStart();
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
      }

      parentId = this.pageCache[currentPath].id;
    }

    return parentId;
  }

  private async findOrCreateFolderPage(folderName: string, parentPageId: string): Promise<string> {
    console.log(`[findOrCreateFolderPage] Looking for folder: ${folderName} (parent: ${parentPageId || 'root'})`);
    const existing = await this.findPageByTitle(folderName, parentPageId);
    if (existing) {
      console.log(`[findOrCreateFolderPage] Found existing folder: ${folderName} (id: ${existing.id})`);
      return existing.id;
    }

    console.log(`[findOrCreateFolderPage] Creating new folder: ${folderName}`);
    const url = `${this.getConfluenceBaseUrl()}/api/v2/pages`;
    const payload: any = {
      spaceId: this.spaceId,
      status: 'current',
      title: folderName,
      body: { value: '', representation: 'storage' }
    };
    if (parentPageId) payload.parentId = parentPageId;

    const response = await this.requestConfluence(url, 'POST', payload);
    console.log(`[findOrCreateFolderPage] Created folder: ${folderName} (id: ${response.id})`);
    return response.id;
  }

  buildMarkdownBody(markdown: string): { value: string; representation: string } {
    marked.setOptions({
      mangle: false,
      headerIds: false
    });

    // Normalize line endings to LF for consistent regex matching
    markdown = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Convert Obsidian callouts [!type] to Confluence info macros BEFORE parsing markdown
    // Callout format: > [!type] optional title\n> content lines
    let processedMarkdown = markdown.replace(
      /> \[!(note|tip|warning|info|important|caution|danger|error|success|check|question|quote|abstract|summary|todo|bug|example|faq|help|hint|attention)\](.*?)?\n((?:>.*\n?)*)/gi,
      (match, type, title, body) => {
        const calloutMap: Record<string, string> = {
          note: 'note', tip: 'tip', info: 'info', important: 'note',
          warning: 'warning', caution: 'warning', attention: 'warning',
          danger: 'warning', error: 'warning',
          success: 'tip', check: 'tip', hint: 'tip',
          question: 'note', faq: 'note', help: 'note',
          quote: 'note', abstract: 'note', summary: 'note',
          todo: 'note', bug: 'warning', example: 'info'
        };
        const macroType = calloutMap[type.toLowerCase()] || 'info';
        const titleText = title?.trim() || '';
        const content = body.replace(/^> ?/gm, '').trim();
        const titleAttr = titleText ? ` ac:title="${titleText}"` : '';
        return `\n<ac:structured-macro ac:name="${macroType}"${titleAttr}><ac:rich-text-body><p>${content}</p></ac:rich-text-body></ac:structured-macro>\n`;
      }
    );

    // Remove Obsidian embeds ![[...]] as they won't work in Confluence
    processedMarkdown = processedMarkdown.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, name) => {
      return `_[Embed: ${name}]_`;
    });

    // Convert Obsidian wiki links [[Page Name]] to temporary placeholders
    // Format: [[Page Name]] or [[Page Name|Display Text]]
    processedMarkdown = processedMarkdown.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (match, pageName, displayText) => {
        const display = displayText || pageName;
        const cleanPageName = pageName.trim();
        // Use a special marker that we'll replace in phase 2
        return `[${display}](OBSIDIAN_LINK:${cleanPageName})`;
      }
    );

    let html = marked.parse(processedMarkdown) as string;

    // Convert code blocks with syntax highlighting to Confluence macro format
    html = html.replace(
      /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
      (match, language, code) => {
        const decoded = code
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim();
        return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${language}</ac:parameter><ac:plain-text-body><![CDATA[${decoded}]]></ac:plain-text-body></ac:structured-macro>`;
      }
    );

    // Convert plain code blocks (without language)
    html = html.replace(
      /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
      (match, code) => {
        const decoded = code
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim();
        return `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${decoded}]]></ac:plain-text-body></ac:structured-macro>`;
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
    console.log(`[createOrUpdatePage] Processing page: ${title} (parent: ${parentPageId || 'root'})`);
    const existing = await this.findPageByTitle(title, parentPageId);
    if (existing) {
      console.log(`[createOrUpdatePage] Updating existing page: ${title} (id: ${existing.id}, version: ${existing.version})`);
      await this.updatePage(existing.id, existing.version, title, body, parentPageId);
      console.log(`[createOrUpdatePage] ✅ Updated: ${title}`);
      return existing.id;
    } else {
      console.log(`[createOrUpdatePage] Creating new page: ${title}`);
      const pageId = await this.createPage(title, body, parentPageId);
      console.log(`[createOrUpdatePage] ✅ Created: ${title}`);
      return pageId;
    }
  }

  async findPageByTitle(title: string, parentPageId?: string): Promise<{ id: string; version: number } | null> {
    const url = `${this.getConfluenceBaseUrl()}/rest/api/content?title=${encodeURIComponent(title)}&spaceKey=${encodeURIComponent(this.settings.spaceKey)}&expand=version`;

    const response = await this.requestConfluence(url, 'GET');
    if (response && response.results && response.results.length > 0) {
      let targetPage = response.results[0];

      if (parentPageId && response.results.length > 1) {
        const childPage = response.results.find((p: any) =>
          p.ancestors?.some((a: any) => a.id === parentPageId)
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

    const payload: any = {
      spaceId: this.spaceId,
      status: 'current',
      title,
      body
    };

    if (parentPageId) {
      payload.parentId = parentPageId;
    }

    console.log(`[createPage] POST to ${url}`);
    console.log(`[createPage] Payload: title="${title}", representation="${body.representation}", bodyLength=${body.value.length}`);
    const response = await this.requestConfluence(url, 'POST', payload);
    console.log(`[createPage] ✅ Created page ID: ${response.id}`);

    // Track version for future updates
    this.pageVersions[response.id] = response.version?.number || 1;

    return response.id;
  }

  async updatePage(pageId: string, currentVersion: number, title: string, body: { value: string; representation: string }, parentPageId: string) {
    const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;

    const payload: any = {
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

    console.log(`[updatePage] PUT to ${url}`);
    console.log(`[updatePage] Payload: title="${title}", version=${currentVersion + 1}, bodyLength=${body.value.length}`);
    await this.requestConfluence(url, 'PUT', payload);
    console.log(`[updatePage] ✅ Updated page ID: ${pageId}`);
  }

  private async updatePageContent(pageId: string, body: { value: string; representation: string }) {
    try {
      const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
      const pageData = await this.requestConfluence(url, 'GET');

      const payload = {
        id: pageId,
        status: 'current',
        title: pageData.title,
        body,
        version: {
          number: pageData.version.number + 1
        }
      };

      await this.requestConfluence(url, 'PUT', payload);
      console.log(`[updatePageContent] ✅ Updated content for page ${pageId}`);
    } catch (error) {
      console.error(`[updatePageContent] ❌ Failed to update page ${pageId}:`, error);
      throw error;
    }
  }

  async requestConfluence(url: string, method: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(`${this.settings.username}:${this.settings.apiToken}`)}`
    };

    const requestOptions: any = {
      url,
      method,
      headers
    };

    if (body) {
      requestOptions.body = JSON.stringify(body);
      console.log(`[requestConfluence] Request body (${method}):`, JSON.stringify(body, null, 2));
    }

    const response = await requestUrl(requestOptions);
    console.log(`[requestConfluence] Response status: ${response.status}`);

    if (response.status < 200 || response.status >= 300) {
      console.error(`[requestConfluence] ERROR ${response.status}`);
      console.error(`[requestConfluence] statusText:`, (response as any).statusText);
      console.error(`[requestConfluence] text length:`, response.text?.length);
      if (response.text) {
        console.error(`[requestConfluence] text:`, response.text.substring(0, 1000));
      }
      try {
        if (response.json) {
          console.error(`[requestConfluence] json:`, response.json);
        }
      } catch (e) {
        console.error(`[requestConfluence] Failed to parse json:`, e);
      }

      let errorMsg = 'Unknown error';
      if (response.text) {
        errorMsg = response.text;
      } else if (response.json) {
        errorMsg = JSON.stringify(response.json);
      }

      console.error(`[requestConfluence] Final error message:`, errorMsg);
      throw new Error(`Confluence request failed (${response.status}): ${errorMsg}`);
    }
    return response.json;
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async saveSyncState() {
    const state: SyncState = {
      pageMap: this.pageMap,
      pageVersions: this.pageVersions,
      processedFiles: Array.from(this.processedFiles),
      timestamp: Date.now()
    };
    await this.saveData({ ...this.settings, syncState: state });
    console.log(`[Sync State] Saved state with ${Object.keys(this.pageMap).length} pages`);
  }

  private async loadSyncState(): Promise<SyncState | null> {
    const data = await this.loadData();
    if (data?.syncState) {
      this.pageMap = data.syncState.pageMap || {};
      this.pageVersions = data.syncState.pageVersions || {};
      this.processedFiles = new Set(data.syncState.processedFiles || []);
      console.log(`[Sync State] Loaded state with ${Object.keys(this.pageMap).length} pages, ${this.processedFiles.size} processed files`);
      return data.syncState;
    }
    return null;
  }

  private clearSyncState() {
    this.pageMap = {};
    this.pageVersions = {};
    this.processedFiles = new Set();
    console.log(`[Sync State] Cleared sync state`);
  }

  private async updateAllPageLinks() {
    console.log(`[updateAllPageLinks] Starting phase 2 with ${Object.keys(this.pageMap).length} pages`);
    let updated = 0;

    for (const [title, pageId] of Object.entries(this.pageMap)) {
      if (!this.isSyncing) {
        console.log(`[updateAllPageLinks] Stopped by user`);
        await this.saveSyncState();
        new Notice(`⏹️ Link update paused. ${updated} pages updated so far.`);
        return;
      }

      try {
        // Fetch current page to get content and version
        const url = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
        const pageData = await this.requestConfluence(url, 'GET');

        if (!pageData.body?.storage?.value) {
          console.log(`[updateAllPageLinks] Page ${title} (${pageId}) has no body, skipping`);
          continue;
        }

        let content = pageData.body.storage.value;
        let hasLinks = false;

        const resolveLink = (pageName: string): string | null => {
          const cleanName = pageName.trim();
          const linkedPageId = this.pageMap[cleanName];
          if (!linkedPageId) {
            // Try to find by basename only (strip folder prefix)
            const baseName = cleanName.split('/').pop() || cleanName;
            const byBase = Object.entries(this.pageMap).find(([k]) => k === baseName || k.endsWith('/' + baseName));
            if (byBase) return byBase[1];
            console.warn(`[updateAllPageLinks] Unresolved link: ${cleanName}`);
            return null;
          }
          return linkedPageId;
        };

        const buildUrl = (pageId: string, pageName: string): string => {
          const baseUrl = this.getConfluenceBaseUrl().replace(/\/wiki$/, '');
          const spaceKey = this.settings.spaceKey;
          return `${baseUrl}/wiki/spaces/${spaceKey}/pages/${pageId}/${pageName.trim().replace(/\s+/g, '+')}`;
        };

        // Replace <a href="OBSIDIAN_LINK:pageName"> (marked parsed single-word links into real <a> tags)
        content = content.replace(/href="OBSIDIAN_LINK:([^"]+)"/g, (match: string, pageName: string) => {
          const pageId = resolveLink(pageName);
          if (pageId) { hasLinks = true; return `href="${buildUrl(pageId, pageName)}"`; }
          return match;
        });

        // Replace [text](OBSIDIAN_LINK:pageName) (multi-word links marked left as plain text)
        content = content.replace(/\[([^\]]+)\]\(OBSIDIAN_LINK:([^)]+)\)/g, (match: string, text: string, pageName: string) => {
          const pageId = resolveLink(pageName);
          if (pageId) { hasLinks = true; return `<a href="${buildUrl(pageId, pageName)}">${text}</a>`; }
          return match;
        });

        // If links were updated, save the page
        if (hasLinks) {
          const updatePayload = {
            id: pageId,
            status: 'current',
            title,
            body: {
              value: content,
              representation: 'storage'
            },
            version: {
              number: pageData.version.number + 1
            }
          };

          const updateUrl = `${this.getConfluenceBaseUrl()}/api/v2/pages/${pageId}`;
          await this.requestConfluence(updateUrl, 'PUT', updatePayload);
          updated++;
          console.log(`[updateAllPageLinks] ✅ Updated links in: ${title}`);
        }
      } catch (error) {
        console.error(`[updateAllPageLinks] ❌ Failed to update ${title}:`, error);
      }
    }

    new Notice(`🔗 Link update complete: ${updated} pages updated.`, 5000);
    console.log(`[updateAllPageLinks] Phase 2 complete: ${updated} pages updated`);
  }
}
