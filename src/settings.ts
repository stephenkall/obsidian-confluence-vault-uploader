import { App, PluginSettingTab, Setting, SettingDefinitionItem, Notice, requestUrl } from 'obsidian';
import ConfluenceVaultUploaderPlugin from './main';

export type LogLevel = 'none' | 'normal' | 'verbose';

export interface ConfluenceVaultUploaderSettings {
  confluenceBaseUrl: string;
  username: string;
  apiToken: string;
  spaceKey: string;
  rootPageId: string;
  rootPageTitle?: string;
  rootPageUrl?: string;
  logLevel: LogLevel;
  syncConcurrency: number;
}

export const DEFAULT_SETTINGS: ConfluenceVaultUploaderSettings = {
  confluenceBaseUrl: '',
  username: '',
  apiToken: '',
  spaceKey: '',
  rootPageId: '',
  rootPageTitle: '',
  rootPageUrl: '',
  logLevel: 'normal',
  syncConcurrency: 4
};

export class ConfluenceVaultUploaderSettingTab extends PluginSettingTab {
  plugin: ConfluenceVaultUploaderPlugin;
  private confirmEl?: HTMLElement;

  constructor(app: App, plugin: ConfluenceVaultUploaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Each field is rendered by a dedicated method that both display() and
  // getSettingDefinitions() call, so the imperative page and the declarative
  // search-index metadata (Obsidian 1.13.0+) stay in sync from one source of truth.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConfluenceBaseUrl(new Setting(containerEl));
    this.renderUsername(new Setting(containerEl));
    this.renderApiToken(new Setting(containerEl));
    this.renderRootPageUrl(new Setting(containerEl));
    this.renderTestConnection(new Setting(containerEl));

    new Setting(containerEl).setName('Sync visibility').setHeading();

    this.renderLogLevel(new Setting(containerEl));
    this.renderSyncStatus(new Setting(containerEl));
    this.renderRepairCache(new Setting(containerEl));

    new Setting(containerEl).setName('Performance').setHeading();

    this.renderSyncConcurrency(new Setting(containerEl));
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Confluence base URL',
        desc: 'Example: https://example.atlassian.net/wiki',
        render: (setting: Setting) => this.renderConfluenceBaseUrl(setting)
      },
      {
        name: 'Confluence username',
        desc: 'Your Confluence account email or username',
        render: (setting: Setting) => this.renderUsername(setting)
      },
      {
        name: 'Confluence API token',
        desc: 'Use an API token for auth. Keep it secret.',
        render: (setting: Setting) => this.renderApiToken(setting)
      },
      {
        name: 'Root page URL (Optional)',
        desc: 'Paste the full page URL to sync from a specific page.',
        render: (setting: Setting) => this.renderRootPageUrl(setting)
      },
      {
        name: 'Test Connection',
        desc: 'Verify Confluence credentials and page access',
        render: (setting: Setting) => this.renderTestConnection(setting)
      },
      {
        type: 'group',
        heading: 'Sync visibility',
        items: [
          {
            name: 'Log level',
            desc: 'Controls how much detail is recorded in the sync log.',
            render: (setting: Setting) => this.renderLogLevel(setting)
          },
          {
            name: 'Sync status',
            desc: 'Open the current sync status.',
            render: (setting: Setting) => this.renderSyncStatus(setting)
          },
          {
            name: 'Repair sync cache',
            desc: 'Checks every cached page mapping against Confluence and removes stale entries.',
            render: (setting: Setting) => this.renderRepairCache(setting)
          }
        ]
      },
      {
        type: 'group',
        heading: 'Performance',
        items: [
          {
            name: 'Sync concurrency',
            desc: 'How many pages to sync at the same time.',
            render: (setting: Setting) => this.renderSyncConcurrency(setting)
          }
        ]
      }
    ];
  }

  private renderConfluenceBaseUrl(setting: Setting): void {
    setting
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
  }

  private renderUsername(setting: Setting): void {
    setting
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
  }

  private renderApiToken(setting: Setting): void {
    setting
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
  }

  private renderRootPageUrl(setting: Setting): void {
    setting
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
                this.confirmEl?.setText(`✅ Extracted: Space=${spaceKey}, PageID=${pageId}`);
                new Notice(`✅ Extracted: Space=${spaceKey}, PageID=${pageId}`);
              } else {
                this.plugin.settings.rootPageId = '';
                this.plugin.settings.spaceKey = '';
                this.confirmEl?.setText('❌ Could not extract page ID and space key from URL');
                new Notice('❌ Could not extract page ID and space key from URL');
              }
            } else {
              this.plugin.settings.rootPageId = '';
              this.plugin.settings.spaceKey = '';
              this.confirmEl?.setText('');
            }
            await this.plugin.saveSettings();
          })
      );

    this.confirmEl = createEl('p', {
      cls: 'setting-item-description',
      text: this.plugin.settings.rootPageId
        ? `✅ Selected: Space=${this.plugin.settings.spaceKey}, PageID=${this.plugin.settings.rootPageId}`
        : ''
    });
    setting.settingEl.insertAdjacentElement('afterend', this.confirmEl);
  }

  private renderTestConnection(setting: Setting): void {
    setting
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

  private renderLogLevel(setting: Setting): void {
    setting
      .setName('Log level')
      .setDesc(
        'Controls how much detail is recorded in the sync log (see "Show Confluence sync log" command). ' +
          'Errors are always recorded regardless of this setting.'
      )
      .addDropdown(dropdown =>
        dropdown
          .addOptions({ none: 'None', normal: 'Normal', verbose: 'Verbose' })
          .setValue(this.plugin.settings.logLevel)
          .onChange(async value => {
            this.plugin.settings.logLevel = value as ConfluenceVaultUploaderSettings['logLevel'];
            await this.plugin.saveSettings();
          })
      );
  }

  private renderSyncStatus(setting: Setting): void {
    setting
      .setName('Sync status')
      .setDesc('Open the current sync status (also shown in the status bar and via the "Show Confluence sync status" command).')
      .addButton(button =>
        button.setButtonText('Show status').onClick(() => {
          this.plugin.openStatusModal();
        })
      );
  }

  private renderRepairCache(setting: Setting): void {
    setting
      .setName('Repair sync cache')
      .setDesc(
        'Checks every cached page mapping against Confluence and removes stale entries (e.g. pages that were deleted, ' +
          'or whose ID no longer resolves). Files affected by a removed mapping are queued for re-sync. Run this if you see ' +
          '"Request failed, status 404" errors during sync.'
      )
      .addButton(button =>
        button.setButtonText('Repair cache').onClick(async () => {
          await this.plugin.repairSyncCache();
        })
      );
  }

  private renderSyncConcurrency(setting: Setting): void {
    setting
      .setName('Sync concurrency')
      .setDesc(
        'How many pages to sync at the same time. Higher values finish large vaults faster but increase the risk of ' +
          'hitting Confluence\'s rate limits (a 429 response), which the sync automatically waits out and retries. ' +
          '1 disables concurrency entirely (one page at a time, matching the original behavior).'
      )
      .addDropdown(dropdown =>
        dropdown
          .addOptions({ '1': '1 (sequential)', '2': '2', '4': '4 (default)', '6': '6', '8': '8' })
          .setValue(String(this.plugin.settings.syncConcurrency))
          .onChange(async value => {
            this.plugin.settings.syncConcurrency = Number(value);
            await this.plugin.saveSettings();
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
    const { confluenceBaseUrl, username, apiToken, rootPageId, spaceKey } = this.plugin.settings;

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
          const pageData = pageResponse.json as { title: string };
          new Notice(`✅ Connection successful! Page found: ${pageData.title}`);
        } else {
          new Notice(`❌ Could not access page (${pageResponse.status}). Please check the URL.`);
        }
      } else {
        new Notice('✅ Connection successful! (No page URL specified)');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`❌ Connection failed: ${detail}`);
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
