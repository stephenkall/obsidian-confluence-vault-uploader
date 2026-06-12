import { App, Modal, requestUrl, Notice } from 'obsidian';

export interface ConfluencePage {
  id: string;
  title: string;
  children?: ConfluencePage[];
  hasChildren?: boolean;
}

export interface PageBrowserOptions {
  confluenceBaseUrl: string;
  username: string;
  apiToken: string;
  spaceKey: string;
  onSelect: (page: ConfluencePage) => void;
}

export class PageBrowserModal extends Modal {
  private options: PageBrowserOptions;
  private rootPages: ConfluencePage[] = [];
  private currentLevel: ConfluencePage[] = [];
  private breadcrumbs: ConfluencePage[] = [];

  constructor(app: App, options: PageBrowserOptions) {
    super(app);
    this.options = options;
  }

  async onOpen() {
    this.renderHeader();
    await this.loadRootPages();
    this.renderList();
  }

  private renderHeader() {
    const { containerEl } = this;
    containerEl.empty();

    const header = containerEl.createEl('h2', { text: 'Select Confluence Page' });
    (header as any).style.marginBottom = '12px';

    const breadcrumb = containerEl.createEl('p', { cls: 'setting-item-description' });
    this.updateBreadcrumb(breadcrumb);
  }

  private updateBreadcrumb(el: HTMLElement) {
    const path = this.breadcrumbs.length === 0
      ? 'Root'
      : this.breadcrumbs.map(p => p.title).join(' > ');
    el.setText(path);
  }

  private async loadRootPages() {
    try {
      new Notice('Loading pages...');
      const baseUrl = this.getBaseUrl();
      const url = `${baseUrl}/rest/api/content?type=page&spaceKey=${encodeURIComponent(this.options.spaceKey)}&expand=ancestors,children.page&limit=250`;

      console.log('Loading from:', url);
      const response = await this.requestConfluence(url);

      if (response?.results) {
        // Filter root pages (no ancestors)
        this.rootPages = response.results
          .filter((p: any) => !p.ancestors || p.ancestors.length === 0)
          .map((p: any) => ({
            id: p.id,
            title: p.title,
            hasChildren: p.children?.page?.length > 0
          }));

        console.log(`Found ${this.rootPages.length} root pages`);
        this.currentLevel = this.rootPages;
      }
    } catch (error) {
      console.error('Error loading pages:', error);
      new Notice(`Error: ${error}`);
      this.close();
    }
  }

  private async loadChildPages(page: ConfluencePage) {
    if (page.children) return;

    try {
      const baseUrl = this.getBaseUrl();
      const url = `${baseUrl}/rest/api/content/${page.id}/child/page?limit=250`;

      const response = await this.requestConfluence(url);
      page.children = (response?.results || []).map((p: any) => ({
        id: p.id,
        title: p.title,
        hasChildren: !!p._links?.childPage?.href
      }));
    } catch (error) {
      console.error('Error loading children:', error);
      page.children = [];
    }
  }

  private renderList() {
    const { containerEl } = this;

    // Remove old list
    const oldList = containerEl.querySelector('.page-list-container');
    if (oldList) oldList.remove();

    const listDiv = containerEl.createDiv({ cls: 'page-list-container' });
    (listDiv as any).style.border = '1px solid var(--background-tertiary)';
    (listDiv as any).style.borderRadius = '4px';
    (listDiv as any).style.maxHeight = '400px';
    (listDiv as any).style.overflowY = 'auto';
    (listDiv as any).style.marginBottom = '12px';
    (listDiv as any).style.backgroundColor = 'var(--background-secondary)';

    this.currentLevel.forEach(page => {
      const item = listDiv.createEl('div');
      (item as any).style.padding = '8px 12px';
      (item as any).style.borderBottom = '1px solid var(--background-tertiary)';
      (item as any).style.cursor = 'pointer';

      item.onmouseenter = () => {
        (item as any).style.backgroundColor = 'var(--background-tertiary)';
      };
      item.onmouseleave = () => {
        (item as any).style.backgroundColor = 'transparent';
      };

      const text = page.hasChildren ? `📁 ${page.title}` : `📄 ${page.title}`;
      item.setText(text);

      item.onclick = async () => {
        if (page.hasChildren) {
          await this.loadChildPages(page);
          if (page.children && page.children.length > 0) {
            this.breadcrumbs.push(page);
            this.currentLevel = page.children;
            this.renderHeader();
            this.renderList();
            this.renderButtons();
            return;
          }
        }

        this.options.onSelect(page);
        this.close();
      };
    });

    this.renderButtons();
  }

  private renderButtons() {
    const { containerEl } = this;

    const oldButtons = containerEl.querySelector('.button-group');
    if (oldButtons) oldButtons.remove();

    const buttonDiv = containerEl.createDiv({ cls: 'button-group' });
    (buttonDiv as any).style.display = 'flex';
    (buttonDiv as any).style.gap = '8px';

    if (this.breadcrumbs.length > 0) {
      const backBtn = buttonDiv.createEl('button', { text: '← Back' });
      (backBtn as any).style.flex = '1';
      backBtn.onclick = () => {
        this.breadcrumbs.pop();
        this.currentLevel = this.breadcrumbs.length > 0
          ? this.breadcrumbs[this.breadcrumbs.length - 1].children || []
          : this.rootPages;
        this.renderHeader();
        this.renderList();
      };
    }

    const cancelBtn = buttonDiv.createEl('button', { text: 'Cancel' });
    (cancelBtn as any).style.flex = '1';
    cancelBtn.onclick = () => this.close();
  }

  private getBaseUrl(): string {
    let url = this.options.confluenceBaseUrl.trim();
    if (!url.endsWith('/wiki') && !url.includes('/wiki/')) {
      url = url.replace(/\/$/, '') + '/wiki';
    }
    return url.replace(/\/$/, '');
  }

  private async requestConfluence(url: string): Promise<any> {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${btoa(`${this.options.username}:${this.options.apiToken}`)}`
    };

    try {
      const response = await requestUrl({ url, method: 'GET', headers });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json;
    } catch (error) {
      console.error('Request failed:', error);
      throw error;
    }
  }
}
