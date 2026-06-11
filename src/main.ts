import { App, MarkdownView, Notice, Plugin, requestUrl, TFile } from 'obsidian';
import { marked } from 'marked';
import { ConfluenceVaultUploaderSettingTab, ConfluenceVaultUploaderSettings, DEFAULT_SETTINGS } from './settings';

export default class ConfluenceVaultUploaderPlugin extends Plugin {
  settings: ConfluenceVaultUploaderSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'push-vault-to-confluence',
      name: 'Push vault to Confluence',
      callback: async () => this.pushVaultToConfluence()
    });

    this.addCommand({
      id: 'push-current-note-to-confluence',
      name: 'Push current note to Confluence',
      callback: async () => this.pushCurrentNoteToConfluence()
    });

    this.addSettingTab(new ConfluenceVaultUploaderSettingTab(this.app, this));
  }

  async pushCurrentNoteToConfluence() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      new Notice('Open a markdown note before pushing to Confluence.');
      return;
    }

    const file = activeView.file;
    await this.pushFileToConfluence(file);
  }

  async pushVaultToConfluence() {
    if (!this.validateSettings()) {
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) {
      new Notice('No markdown files found in the vault.');
      return;
    }

    new Notice(`Uploading ${files.length} file(s) to Confluence...`);

    let successCount = 0;
    let failureCount = 0;

    for (const file of files) {
      try {
        await this.pushFileToConfluence(file);
        successCount += 1;
      } catch (error) {
        console.error('Failed to upload file', file.path, error);
        failureCount += 1;
      }
    }

    new Notice(`Confluence upload complete: ${successCount} success, ${failureCount} failed.`);
  }

  async pushFileToConfluence(file: TFile) {
    if (!this.validateSettings()) {
      throw new Error('Invalid Confluence settings');
    }

    const markdown = await this.app.vault.read(file);
    const html = this.convertMarkdownToHtml(markdown);
    const title = this.buildConfluenceTitle(file);
    const body = this.buildStorageBody(html);

    await this.createOrUpdatePage(title, body);
  }

  convertMarkdownToHtml(markdown: string): string {
    return marked.parse(markdown, { mangle: false, headerIds: false });
  }

  buildConfluenceTitle(file: TFile): string {
    const relativePath = file.path.replace(/\\/g, '/');
    return `Vault: ${relativePath}`;
  }

  buildStorageBody(html: string): { storage: { value: string; representation: string } } {
    return {
      storage: {
        value: `<div>${html}</div>`,
        representation: 'storage'
      }
    };
  }

  async createOrUpdatePage(title: string, body: { storage: { value: string; representation: string } }) {
    const existing = await this.findPageByTitle(title);
    if (existing) {
      await this.updatePage(existing.id, existing.version, title, body);
    } else {
      await this.createPage(title, body);
    }
  }

  async findPageByTitle(title: string): Promise<{ id: string; version: number } | null> {
    const url = `${this.settings.confluenceBaseUrl.replace(/\/$/, '')}/rest/api/content?title=${encodeURIComponent(title)}&spaceKey=${encodeURIComponent(this.settings.spaceKey)}&expand=version`;

    const response = await this.requestConfluence(url, 'GET');
    if (response && response.results && response.results.length > 0) {
      const page = response.results[0];
      return {
        id: page.id,
        version: page.version?.number ?? 1
      };
    }

    return null;
  }

  async createPage(title: string, body: { storage: { value: string; representation: string } }) {
    const url = `${this.settings.confluenceBaseUrl.replace(/\/$/, '')}/rest/api/content`;
    const payload = {
      type: 'page',
      title,
      space: { key: this.settings.spaceKey },
      ancestors: [{ id: this.settings.parentPageId }],
      body: {
        storage: body.storage
      }
    };

    await this.requestConfluence(url, 'POST', payload);
  }

  async updatePage(pageId: string, currentVersion: number, title: string, body: { storage: { value: string; representation: string } }) {
    const url = `${this.settings.confluenceBaseUrl.replace(/\/$/, '')}/rest/api/content/${pageId}`;
    const payload = {
      id: pageId,
      type: 'page',
      title,
      version: { number: currentVersion + 1 },
      ancestors: [{ id: this.settings.parentPageId }],
      body: {
        storage: body.storage
      }
    };

    await this.requestConfluence(url, 'PUT', payload);
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
    }

    const response = await requestUrl(requestOptions);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Confluence request failed (${response.status}): ${response.text}`);
    }
    return response.json;
  }

  validateSettings(): boolean {
    const { confluenceBaseUrl, username, apiToken, spaceKey, parentPageId } = this.settings;
    if (!confluenceBaseUrl || !username || !apiToken || !spaceKey || !parentPageId) {
      new Notice('Please configure all Confluence settings before pushing.');
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
}
