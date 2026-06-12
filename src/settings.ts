import { App, PluginSettingTab, Setting, Notice, requestUrl } from 'obsidian';
import ConfluenceVaultUploaderPlugin from './main';

export interface ConfluenceVaultUploaderSettings {
  confluenceBaseUrl: string;
  username: string;
  apiToken: string;
  spaceKey: string;
  rootPageId: string;
  rootPageTitle?: string;
  rootPageUrl?: string;
}

export const DEFAULT_SETTINGS: ConfluenceVaultUploaderSettings = {
  confluenceBaseUrl: '',
  username: '',
  apiToken: '',
  spaceKey: '',
  rootPageId: '',
  rootPageTitle: '',
  rootPageUrl: ''
};

export class ConfluenceVaultUploaderSettingTab extends PluginSettingTab {
  plugin: ConfluenceVaultUploaderPlugin;

  constructor(app: App, plugin: ConfluenceVaultUploaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('Confluence Vault Uploader Settings').setHeading();

    new Setting(containerEl)
      .setName('Confluence base URL')
      .setDesc('Example: https://example.atlassian.net/wiki')
      .addText(text =>
        text
          .setPlaceholder('https://your-domain.atlassian.net/wiki')
          .setValue(this.plugin.settings.confluenceBaseUrl)
          .onChange(async value => {
            this.plugin.settings.confluenceBaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Confluence username')
      .setDesc('Your Confluence account email or username')
      .addText(text =>
        text
          .setPlaceholder('username@example.com')
          .setValue(this.plugin.settings.username)
          .onChange(async value => {
            this.plugin.settings.username = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Confluence API token')
      .setDesc('Use an API token for auth. Keep it secret.')
      .addText(text => {
        text
          .setPlaceholder('API token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async value => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        return text;
      });

    new Setting(containerEl)
      .setName('Root page URL (Optional)')
      .setDesc('Paste the full page URL to sync from a specific page. Leave empty to sync from space root. The space key will be extracted from the URL.')
      .addText(text =>
        text
          .setPlaceholder('https://your-domain.atlassian.net/wiki/spaces/SPACE/pages/12345678/Page+Name')
          .setValue(this.plugin.settings.rootPageUrl || '')
          .onChange(async value => {
            this.plugin.settings.rootPageUrl = value.trim();
            if (value.trim()) {
              const { pageId, spaceKey } = this.extractPageAndSpaceFromUrl(value.trim());
              if (pageId && spaceKey) {
                this.plugin.settings.rootPageId = pageId;
                this.plugin.settings.spaceKey = spaceKey;
                new Notice(`✅ Extracted: Space=${spaceKey}, PageID=${pageId}`);
              } else {
                this.plugin.settings.rootPageId = '';
                this.plugin.settings.spaceKey = '';
                new Notice('❌ Could not extract page ID and space key from URL');
              }
            } else {
              this.plugin.settings.rootPageId = '';
              this.plugin.settings.spaceKey = '';
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.rootPageId) {
      containerEl.createEl('p', {
        text: `✅ Selected: Space=${this.plugin.settings.spaceKey}, PageID=${this.plugin.settings.rootPageId}`,
        cls: 'setting-item-description'
      });
    }

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify Confluence credentials and page access')
      .addButton(button =>
        button
          .setButtonText('Test')
          .onClick(async () => {
            await this.testConnection();
          })
      );
  }

  private extractPageAndSpaceFromUrl(url: string): { pageId: string; spaceKey: string } {
    const pageIdMatch = url.match(/\/pages\/(\d+)/);
    const spaceKeyMatch = url.match(/\/spaces\/([A-Z0-9_]+)/i);

    return {
      pageId: pageIdMatch && pageIdMatch[1] ? pageIdMatch[1] : '',
      spaceKey: spaceKeyMatch && spaceKeyMatch[1] ? spaceKeyMatch[1] : ''
    };
  }

  private async testConnection() {
    let { confluenceBaseUrl, username, apiToken, rootPageId, spaceKey } = this.plugin.settings;

    if (!confluenceBaseUrl || !username || !apiToken) {
      new Notice('❌ Please fill in URL, username, and API token first.');
      return;
    }

    new Notice('Testing connection...');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Basic ${btoa(`${username}:${apiToken}`)}`
      };

      const baseUrl = this.getBaseUrl();
      const url = `${baseUrl}/rest/api/content?limit=1`;

      const response = await requestUrl({
        url,
        method: 'GET',
        headers
      });

      if (response.status < 200 || response.status >= 300) {
        new Notice(`❌ Connection failed (${response.status})`);
        return;
      }

      // Connection successful, now check page if specified
      if (rootPageId && spaceKey) {
        new Notice('Validating page access...');
        const pageUrl = `${baseUrl}/rest/api/content/${rootPageId}`;
        const pageResponse = await requestUrl({
          url: pageUrl,
          method: 'GET',
          headers
        });

        if (pageResponse.status >= 200 && pageResponse.status < 300) {
          const pageData = pageResponse.json;
          new Notice(`✅ Connection successful! Page found: ${pageData.title}`);
        } else {
          new Notice(`❌ Could not access page (${pageResponse.status}). Please check the URL.`);
        }
      } else {
        new Notice('✅ Connection successful! (No page URL specified)');
      }
    } catch (error) {
      new Notice(`❌ Connection failed: ${error}`);
    }
  }

  private getBaseUrl(): string {
    let url = this.plugin.settings.confluenceBaseUrl.trim();
    if (!url.endsWith('/wiki') && !url.includes('/wiki/')) {
      url = url.replace(/\/$/, '') + '/wiki';
    }
    return url.replace(/\/$/, '');
  }
}
