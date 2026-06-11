import { App, PluginSettingTab, Setting } from 'obsidian';
import ConfluenceVaultUploaderPlugin from './main';

export interface ConfluenceVaultUploaderSettings {
  confluenceBaseUrl: string;
  username: string;
  apiToken: string;
  spaceKey: string;
  parentPageId: string;
}

export const DEFAULT_SETTINGS: ConfluenceVaultUploaderSettings = {
  confluenceBaseUrl: '',
  username: '',
  apiToken: '',
  spaceKey: '',
  parentPageId: ''
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

    containerEl.createEl('h2', { text: 'Confluence Vault Uploader Settings' });

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
      .addText(text =>
        text
          .setPlaceholder('API token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async value => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Confluence space key')
      .setDesc('The Confluence space where pages will be created/updated')
      .addText(text =>
        text
          .setPlaceholder('SPACE')
          .setValue(this.plugin.settings.spaceKey)
          .onChange(async value => {
            this.plugin.settings.spaceKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Confluence parent page ID')
      .setDesc('Upload pages under this parent page in Confluence')
      .addText(text =>
        text
          .setPlaceholder('123456789')
          .setValue(this.plugin.settings.parentPageId)
          .onChange(async value => {
            this.plugin.settings.parentPageId = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
