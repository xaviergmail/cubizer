import { SIZE_MODES, type Panel, type PanelType, type SizeMode } from './model';

export type MaterialTarget = 'metal' | 'connector';

export interface UICallbacks {
  onTypeClick(id: string): void;
  onAddCustom(color: string): string;
  onSetTypeColor(id: string, color: string): void;
  onSetMaterialColor(target: MaterialTarget, color: string): void;
  onRemoveType(id: string, replacementId: string | null): void;
  onRemoveSelected(): void;
  onTableSelect(len: number): void;
  onQuickModeChange(enabled: boolean): void;
  onSaveNamed(name: string): boolean;
  onLoadNamed(name: string): boolean;
  onListDesignNames(): string[];
  onNew(): void;
  onShare(): Promise<boolean>;
  onDumpState(): Promise<boolean>;
  onUndo(): void;
  onRedo(): void;
  onTypePointerDown(id: string, event: PointerEvent): void;
  onResetView(): void;
  onSizeSelect(mode: SizeMode): void;
}

const TRASH_ICON = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
const BUG_ICON = '<i class="fa-solid fa-bug" aria-hidden="true"></i>';
const CLOSE_ICON = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
const ICON = (name: string) => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;

const TABLE_OPTIONS: Array<[number, string]> = [[36, '3 ft'], [48, '4 ft'], [72, '6 ft'], [96, '8 ft']];
const PALETTE = [
  '#111827', '#ef4444', '#f97316', '#facc15', '#84cc16', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#f43f5e', '#a16207', '#78716c', '#f8fafc',
];

function hexToHsl(color: string): { h: number; s: number; l: number } {
  const value = Number.parseInt(color.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const hue = delta === 0 ? 0 : ((max === r
    ? (g - b) / delta + (g < b ? 6 : 0)
    : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60);
  return { h: Math.round(hue) % 360, s: Math.round(saturation * 100), l: Math.round(lightness * 100) };
}

function hslToHex(h: number, s: number, l: number): string {
  const lightness = l / 100;
  const chroma = (s / 100) * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => Math.round(255 * (lightness - chroma * Math.max(-1, Math.min((n + h / 30) % 12 - 3, 9 - (n + h / 30) % 12, 1)))).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
const GITHUB_URL = 'https://github.com/xaviergmail/cubizer';

type ColorTarget =
  | { kind: 'new' }
  | { kind: 'type'; id: string }
  | { kind: 'material'; target: MaterialTarget };

interface CountType extends PanelType { count: number; }

export class UI {
  private sizeButtons: Array<{ el: HTMLButtonElement; mode: SizeMode }> = [];
  private typeList: HTMLDivElement;
  private addBtn: HTMLButtonElement;
  private selectedTrash: HTMLButtonElement;
  private dumpBtn: HTMLButtonElement;
  private quickBtn: HTMLButtonElement;
  private materialButtons = new Map<MaterialTarget, HTMLButtonElement>();

  private status: HTMLDivElement;
  private statusTimer: number | undefined;
  private tableButtons: Array<{ el: HTMLButtonElement; len: number }> = [];
  private types = new Map<string, PanelType>();
  private colorDialog: HTMLDialogElement;
  private colorDialogTitle: HTMLHeadingElement;
  private colorHex: HTMLInputElement;
  private colorPreview: HTMLSpanElement;
  private colorTarget: ColorTarget | undefined;
  private replacementDialog: HTMLDialogElement;
  private tutorialDialog: HTMLDialogElement;
  private designDialog: HTMLDialogElement;
  private confirmationDialog: HTMLDialogElement;
  private colorSliders!: { root: HTMLDivElement; h: HTMLInputElement; s: HTMLInputElement; l: HTMLInputElement; values: HTMLOutputElement[] };
  private countBar: HTMLDivElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private dragChip: HTMLDivElement;
  private dragChipIcon: HTMLSpanElement;
  private dragChipLabel: HTMLSpanElement;

  constructor(sidebar: HTMLElement, viewport: HTMLElement, private cbs: UICallbacks) {
    const sizeSection = document.createElement('section');
    sizeSection.className = 'size-controls';
    sizeSection.setAttribute('aria-label', 'Panel size');
    const sizeTitles: Record<SizeMode, string> = {
      '12x12': '12 in × 12 in panel',
      '12x16': '12 in wide × 16 in tall (16 vertical)',
      '16x12': '16 in wide × 12 in tall (16 horizontal)',
    };
    for (const mode of SIZE_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'size-btn';
      btn.textContent = mode.replace('x', '×');
      btn.dataset.size = mode;
      btn.title = sizeTitles[mode];
      btn.setAttribute('aria-label', sizeTitles[mode]);
      btn.addEventListener('click', () => {
        this.setSizeMode(mode);
        this.cbs.onSizeSelect(mode);
      });
      sizeSection.appendChild(btn);
      this.sizeButtons.push({ el: btn, mode });
    }
    sidebar.appendChild(sizeSection);

    this.typeList = document.createElement('div');
    this.typeList.className = 'type-list';
    sidebar.appendChild(this.typeList);

    this.addBtn = document.createElement('button');
    this.addBtn.className = 'add-btn';
    this.addBtn.innerHTML = `${ICON('plus')}<span>Add color</span>`;
    this.addBtn.setAttribute('aria-label', 'Add colored panel');
    this.addBtn.title = 'Add colored panel';
    this.addBtn.setAttribute('aria-haspopup', 'dialog');
    this.addBtn.addEventListener('click', () => this.openColorPicker({ kind: 'new' }, '#e74c3c', 'Add colored panel'));
    sidebar.appendChild(this.addBtn);

    this.quickBtn = document.createElement('button');
    this.quickBtn.className = 'quick-mode-btn';
    this.quickBtn.type = 'button';
    this.quickBtn.addEventListener('click', () => this.setQuickMode(this.quickBtn.getAttribute('aria-pressed') !== 'true'));
    sidebar.appendChild(this.quickBtn);
    this.setQuickMode(false, false);

    const materials = document.createElement('section');
    materials.className = 'material-controls';
    materials.setAttribute('aria-label', 'Global materials');
    materials.append(
      this.makeMaterialButton('metal', 'Metal'),
      this.makeMaterialButton('connector', 'Connector'),
    );
    sidebar.appendChild(materials);

    ({ dialog: this.colorDialog, title: this.colorDialogTitle, hex: this.colorHex, preview: this.colorPreview } = this.makeColorDialog());
    this.replacementDialog = this.makeReplacementDialog();
    this.tutorialDialog = this.makeTutorialDialog();
    this.designDialog = this.makeDesignDialog();
    this.confirmationDialog = this.makeConfirmationDialog();

    const footer = document.createElement('div');
    footer.className = 'sidebar-footer';
    const actions = document.createElement('div');
    actions.className = 'assembly-actions';
    actions.append(
      this.makeActionButton('New assembly', 'file', 'Start a fresh assembly', () => {
        this.requestConfirmation('Start a new assembly?', 'The current unsaved assembly will be replaced.', () => {
          this.cbs.onNew();
          this.notify('Started a new assembly');
        });
      }),
      this.makeActionButton('Save design', 'floppy-disk', 'Save this assembly under a name', () => this.openDesignDialog('save')),
      this.makeActionButton('Load design', 'folder-open', 'Load a saved named design', () => this.openDesignDialog('load')),
      this.makeActionButton('Share', 'share-nodes', 'Copy a shareable assembly URL', async () => {
        const shared = await this.cbs.onShare();
        this.notify(shared ? 'Share URL copied' : 'Could not copy share URL', shared ? 'success' : 'error');
      }),
    );
    const github = document.createElement('a');
    github.className = 'sidebar-action github-action';
    github.href = GITHUB_URL;
    github.target = '_blank';
    github.rel = 'noreferrer';
    github.innerHTML = '<i class="fa-brands fa-github" aria-hidden="true"></i>';
    github.setAttribute('aria-label', 'Open the project on GitHub');
    github.title = 'Open the project on GitHub';
    actions.appendChild(github);
    footer.appendChild(actions);

    const historyRow = document.createElement('div');
    historyRow.className = 'history-actions';
    this.undoBtn = this.makeActionButton('Undo', 'rotate-left', 'Undo (Ctrl+Z / ⌘Z)', () => this.cbs.onUndo());
    this.redoBtn = this.makeActionButton('Redo', 'rotate-right', 'Redo (Ctrl+Shift+Z / Ctrl+Y)', () => this.cbs.onRedo());
    historyRow.append(this.undoBtn, this.redoBtn);
    footer.appendChild(historyRow);

    this.dumpBtn = document.createElement('button');
    this.dumpBtn.className = 'dump-state-btn';
    this.dumpBtn.type = 'button';
    this.dumpBtn.title = 'Copy assembly JSON';
    this.dumpBtn.setAttribute('aria-label', 'Copy assembly JSON');
    this.dumpBtn.innerHTML = BUG_ICON;
    this.dumpBtn.addEventListener('click', async () => this.setDumpStatus(await this.cbs.onDumpState()));
    footer.appendChild(this.dumpBtn);
    sidebar.appendChild(footer);

    this.status = document.createElement('div');
    this.status.className = 'action-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    viewport.appendChild(this.status);

    this.dragChip = document.createElement('div');
    this.dragChip.className = 'drag-chip';
    this.dragChipIcon = document.createElement('span');
    this.dragChipIcon.className = 'icon icon-plain';
    this.dragChipLabel = document.createElement('span');
    this.dragChip.append(this.dragChipIcon, this.dragChipLabel);
    document.body.appendChild(this.dragChip);

    this.selectedTrash = this.makeOverlayTrash(viewport, () => this.cbs.onRemoveSelected());

    const help = document.createElement('button');
    help.className = 'help-btn';
    help.type = 'button';
    help.innerHTML = '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
    help.title = 'Show builder tutorial';
    help.setAttribute('aria-label', 'Show builder tutorial');
    help.addEventListener('click', () => this.tutorialDialog.showModal());
    viewport.appendChild(help);

    const cameraReset = document.createElement('button');
    cameraReset.className = 'camera-btn';
    cameraReset.type = 'button';
    cameraReset.innerHTML = ICON('camera-rotate');
    cameraReset.title = 'Reset camera to default view';
    cameraReset.setAttribute('aria-label', 'Reset camera to default view');
    cameraReset.addEventListener('click', () => this.cbs.onResetView());
    viewport.appendChild(cameraReset);

    const selector = document.createElement('div');
    selector.id = 'table-selector';
    for (const [len, label] of TABLE_OPTIONS) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.dataset.len = String(len);
      btn.addEventListener('click', () => this.cbs.onTableSelect(len));
      selector.appendChild(btn);
      this.tableButtons.push({ el: btn, len });
    }
    viewport.appendChild(selector);

    this.countBar = document.createElement('div');
    this.countBar.id = 'count-bar';
    this.countBar.setAttribute('role', 'status');
    this.countBar.setAttribute('aria-live', 'polite');
    viewport.appendChild(this.countBar);
  }

  private makeActionButton(label: string, icon: string, title: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'sidebar-action';
    button.type = 'button';
    button.innerHTML = ICON(icon);
    button.setAttribute('aria-label', label);
    button.title = title;
    button.addEventListener('click', () => { void action(); });
    return button;
  }

  private makeMaterialButton(target: MaterialTarget, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'material-color-btn';
    button.type = 'button';
    button.innerHTML = `${ICON(target === 'metal' ? 'screwdriver-wrench' : 'puzzle-piece')}<span>${label}</span>`;
    button.title = `Change global ${label.toLowerCase()} color`;
    button.setAttribute('aria-label', `Change global ${label.toLowerCase()} color`);
    button.addEventListener('click', () => this.openColorPicker({ kind: 'material', target }, button.style.getPropertyValue('--swatch') || '#2f3945', `Change ${label.toLowerCase()} color`));
    this.materialButtons.set(target, button);
    return button;
  }

  private makeColorDialog(): { dialog: HTMLDialogElement; title: HTMLHeadingElement; hex: HTMLInputElement; preview: HTMLSpanElement } {
    const dialog = document.createElement('dialog');
    dialog.className = 'picker-dialog';
    const header = document.createElement('header');
    const title = document.createElement('h2');
    const close = document.createElement('button');
    close.className = 'dialog-close';
    close.type = 'button';
    close.title = 'Close color picker';
    close.setAttribute('aria-label', 'Close color picker');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => dialog.close());
    header.append(title, close);

    const preview = document.createElement('span');
    preview.className = 'color-preview';
    const sliders = document.createElement('div');
    sliders.className = 'hsl-sliders';
    const values: HTMLOutputElement[] = [];
    const controls = (['Hue', 'Saturation', 'Lightness'] as const).map((label, index) => {
      const row = document.createElement('label');
      row.className = 'hsl-row';
      const caption = document.createElement('span');
      caption.textContent = label[0];
      const input = document.createElement('input');
      input.className = `hsl-range hsl-${label[0].toLowerCase()}`;
      input.type = 'range';
      input.min = '0';
      input.max = index === 0 ? '360' : '100';
      input.step = '1';
      input.setAttribute('aria-label', label);
      const value = document.createElement('output');
      values.push(value);
      row.append(caption, input, value);
      sliders.appendChild(row);
      return input;
    });
    this.colorSliders = { root: sliders, h: controls[0], s: controls[1], l: controls[2], values };
    for (const slider of controls) slider.addEventListener('input', () => {
      const color = hslToHex(Number(this.colorSliders.h.value), Number(this.colorSliders.s.value), Number(this.colorSliders.l.value));
      this.setColorUI(color);
    });
    for (const slider of controls) slider.addEventListener('change', () => this.commitColor(this.colorHex.value, false));

    const palette = document.createElement('div');
    palette.className = 'color-palette';
    palette.setAttribute('aria-label', 'Color palette');
    for (const color of PALETTE) {
      const swatch = document.createElement('button');
      swatch.className = 'palette-swatch';
      swatch.type = 'button';
      swatch.style.setProperty('--swatch', color);
      swatch.title = color;
      swatch.setAttribute('aria-label', `Use ${color}`);
      swatch.addEventListener('click', () => this.commitColor(color));
      palette.appendChild(swatch);
    }

    const hexLabel = document.createElement('label');
    hexLabel.className = 'hex-field';
    hexLabel.textContent = 'Hex';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.maxLength = 7;
    hex.autocomplete = 'off';
    hex.spellcheck = false;
    hex.setAttribute('aria-label', 'Hex color');
    hex.addEventListener('input', () => {
      const color = hex.value.trim().replace(/^([^#])/, '#$1').toLowerCase();
      if (/^#[\da-f]{6}$/.test(color)) this.setColorUI(color, false);
    });
    hex.addEventListener('keydown', (event) => { if (event.key === 'Enter') this.commitColor(hex.value); });
    hex.addEventListener('change', () => this.commitColor(hex.value));
    hexLabel.appendChild(hex);
    dialog.append(header, preview, sliders, palette, hexLabel);
    dialog.addEventListener('close', () => { this.colorTarget = undefined; });
    document.body.appendChild(dialog);
    return { dialog, title, hex, preview };
  }

  private makeReplacementDialog(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'replacement-dialog';
    document.body.appendChild(dialog);
    return dialog;
  }

  private makeConfirmationDialog(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    document.body.appendChild(dialog);
    return dialog;
  }

  private requestConfirmation(titleText: string, bodyText: string, onConfirm: () => void): void {
    const title = document.createElement('h2');
    title.textContent = titleText;
    const body = document.createElement('p');
    body.textContent = bodyText;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.confirmationDialog.close());
    const confirm = document.createElement('button');
    confirm.className = 'danger-confirm';
    confirm.type = 'button';
    confirm.textContent = 'Continue';
    confirm.addEventListener('click', () => {
      this.confirmationDialog.close();
      onConfirm();
    });
    actions.append(cancel, confirm);
    this.confirmationDialog.replaceChildren(title, body, actions);
    this.confirmationDialog.showModal();
  }

  private makeDesignDialog(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'design-dialog';
    document.body.appendChild(dialog);
    return dialog;
  }

  private openDesignDialog(mode: 'save' | 'load'): void {
    const title = document.createElement('h2');
    title.textContent = mode === 'save' ? 'Save named design' : 'Load named design';
    const close = document.createElement('button');
    close.className = 'dialog-close';
    close.type = 'button';
    close.title = 'Close design library';
    close.setAttribute('aria-label', 'Close design library');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => this.designDialog.close());
    const header = document.createElement('header');
    header.append(title, close);
    const names = this.cbs.onListDesignNames();
    const list = document.createElement('div');
    list.className = 'design-list';

    if (mode === 'save') {
      const label = document.createElement('label');
      label.className = 'design-name-field';
      label.textContent = 'Design name';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 60;
      input.placeholder = `Design ${names.length + 1}`;
      input.autofocus = true;
      label.appendChild(input);
      const finishSave = (name: string) => {
        const saved = this.cbs.onSaveNamed(name);
        if (saved) {
          this.designDialog.close();
          this.notify(`Saved “${name}”`);
        } else {
          input.setAttribute('aria-invalid', 'true');
        }
      };
      const requestSave = (rawName: string) => {
        const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!name) {
          input.setAttribute('aria-invalid', 'true');
          return;
        }
        if (!names.includes(name)) {
          finishSave(name);
          return;
        }
        this.designDialog.close();
        this.requestConfirmation(
          `Overwrite “${name}”?`,
          'This will permanently replace the saved design and cannot be undone.',
          () => finishSave(name),
        );
      };
      const save = document.createElement('button');
      save.className = 'primary-dialog-action';
      save.type = 'button';
      save.textContent = 'Save design';
      save.addEventListener('click', () => requestSave(input.value.trim() || input.placeholder));
      for (const name of names) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = name;
        item.addEventListener('click', () => requestSave(name));
        list.appendChild(item);
      }
      this.designDialog.replaceChildren(header, label, save, list);
    } else {
      if (names.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No saved designs in this browser yet.';
        list.appendChild(empty);
      }
      for (const name of names) {
        const item = document.createElement('button');
        item.className = 'saved-design';
        item.type = 'button';
        item.textContent = name;
        item.addEventListener('click', () => {
          this.designDialog.close();
          this.requestConfirmation(
            `Load “${name}”?`,
            'The current unsaved assembly will be replaced.',
            () => {
              const loaded = this.cbs.onLoadNamed(name);
              this.notify(loaded ? `Loaded “${name}”` : `Could not load “${name}”`, loaded ? 'success' : 'error');
            },
          );
        });
        list.appendChild(item);
      }
      this.designDialog.replaceChildren(header, list);
    }
    this.designDialog.showModal();
  }

  private makeTutorialDialog(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'tutorial-dialog';
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = 'Build your artist alley display';
    const close = document.createElement('button');
    close.className = 'dialog-close';
    close.type = 'button';
    close.title = 'Close tutorial';
    close.setAttribute('aria-label', 'Close tutorial');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => dialog.close());
    header.append(title, close);
    const steps = [
      ['Navigate', 'Drag with one finger or the left mouse button to orbit. Two fingers pan or pinch to zoom; the mouse wheel also zooms.'],
      ['Panel sizes', 'Pick a panel size in the sidebar: the standard 12×12, a 12×16 with the 16-inch edge vertical, or a 16×12 lying wide. A 16-inch dimension leaves the 12-inch connector grid, so those panels connect only along their 12-inch edges.'],
      ['Place panels', 'Normal mode: tap the table once to place a panel, or tap a panel then tap one of the blue possible-panel previews (the preview under your cursor is outlined). Hold and drag to paint panels across the table and previews. Impossible placements are never shown.'],
      ['Drag to build', 'Drag any panel type from the sidebar onto the table to place it there, or onto a placed panel to re-type that panel.'],
      ['Connectors', 'Connectors are placed and aligned automatically. Free table-edge connectors face inward toward the chair.'],
      ['Panel types', 'Choose a panel type at left, or add any colored plain panel. The Metal and Connector controls set global finishes.'],
      ['Counts', 'The bar at the bottom lists each panel type and the total number of connectors.'],
      ['Undo / Redo', 'The footer buttons (or Ctrl+Z / ⌘Z and Ctrl+Shift+Z / Ctrl+Y) step through placements, deletions, re-types, color changes, table resizes, and even new/loaded assemblies.'],
      ['Table size', 'Choose 3, 4, 6, or 8 feet from the controls above the table.'],
    ];
    const list = document.createElement('ol');
    for (const [label, text] of steps) {
      const item = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = `${label}: `;
      item.append(strong, text);
      list.appendChild(item);
    }
    dialog.append(header, list);
    document.body.appendChild(dialog);
    return dialog;
  }

  private setColorUI(color: string, writeHex = true): void {
    const hsl = hexToHsl(color);
    this.colorPreview.style.setProperty('--swatch', color);
    this.colorSliders.root.style.setProperty('--h', String(hsl.h));
    this.colorSliders.root.style.setProperty('--s', `${hsl.s}%`);
    this.colorSliders.root.style.setProperty('--l', `${hsl.l}%`);
    for (const slider of [this.colorSliders.h, this.colorSliders.s, this.colorSliders.l]) slider.style.setProperty('--swatch', color);
    this.colorSliders.h.value = String(hsl.h);
    this.colorSliders.s.value = String(hsl.s);
    this.colorSliders.l.value = String(hsl.l);
    this.colorSliders.values[0].value = String(hsl.h);
    this.colorSliders.values[1].value = `${hsl.s}%`;
    this.colorSliders.values[2].value = `${hsl.l}%`;
    if (writeHex) this.colorHex.value = color;
    this.colorHex.removeAttribute('aria-invalid');
  }

  private openColorPicker(target: ColorTarget, color: string, title: string): void {
    this.colorTarget = target;
    this.colorDialogTitle.textContent = title;
    this.setColorUI(color);
    this.colorDialog.showModal();
  }

  private commitColor(raw: string, close = true): void {
    const color = raw.trim().replace(/^([^#])/, '#$1').toLowerCase();
    if (!/^#[\da-f]{6}$/.test(color)) {
      this.colorHex.setAttribute('aria-invalid', 'true');
      return;
    }
    if (this.colorTarget?.kind === 'new') {
      const id = this.cbs.onAddCustom(color);
      this.colorTarget = { kind: 'type', id };
    } else if (this.colorTarget?.kind === 'type') this.cbs.onSetTypeColor(this.colorTarget.id, color);
    else if (this.colorTarget?.kind === 'material') this.cbs.onSetMaterialColor(this.colorTarget.target, color);
    if (close) this.colorDialog.close();
  }

  private makeOverlayTrash(viewport: HTMLElement, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'overlay-btn';
    btn.innerHTML = TRASH_ICON;
    btn.addEventListener('click', onClick);
    viewport.appendChild(btn);
    return btn;
  }

  private setDumpStatus(copied: boolean): void {
    this.dumpBtn.classList.toggle('copied', copied);
    this.dumpBtn.classList.toggle('failed', !copied);
    this.dumpBtn.title = copied ? 'Assembly JSON copied' : 'Could not copy assembly JSON';
    window.setTimeout(() => {
      this.dumpBtn.classList.remove('copied', 'failed');
      this.dumpBtn.title = 'Copy assembly JSON';
    }, 1600);
  }

  notify(message: string, kind: 'success' | 'error' = 'success'): void {
    window.clearTimeout(this.statusTimer);
    this.status.textContent = message;
    this.status.className = `action-status visible ${kind}`;
    this.statusTimer = window.setTimeout(() => { this.status.className = 'action-status'; }, 2200);
  }

  setHistoryState(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
  }

  setDragChip(info: { kind: PanelType['kind']; color: string; x: number; y: number; mode: 'place' | 'replace' } | null): void {
    if (!info) {
      this.dragChip.classList.remove('visible', 'replace');
      return;
    }
    this.dragChipIcon.className = `icon icon-${info.kind}`;
    this.dragChipIcon.style.setProperty('--swatch', info.color);
    this.dragChipLabel.textContent = info.mode === 'replace' ? 'Drop to re-type panel' : 'Drop to place panel';
    this.dragChip.classList.toggle('replace', info.mode === 'replace');
    this.dragChip.style.left = `${info.x}px`;
    this.dragChip.style.top = `${info.y}px`;
    this.dragChip.classList.add('visible');
  }

  private makeTypeEntry(type: PanelType, active: boolean): HTMLDivElement {
    const entry = document.createElement('div');
    entry.className = `type-entry${type.custom ? ' custom' : ''}`;
    const btn = document.createElement('button');
    btn.className = `type-btn${active ? ' active' : ''}`;
    btn.dataset.typeId = type.id;
    const icon = document.createElement('span');
    icon.className = `icon icon-${type.kind}`;
    icon.style.setProperty('--swatch', type.color);
    btn.appendChild(icon);
    btn.addEventListener('click', () => this.cbs.onTypeClick(type.id));
    btn.addEventListener('pointerdown', (event) => this.cbs.onTypePointerDown(type.id, event));
    entry.appendChild(btn);

    if (type.kind === 'plain') {
      const color = document.createElement('button');
      color.className = 'type-color-btn';
      color.type = 'button';
      color.style.setProperty('--swatch', type.color);
      color.title = 'Change panel color';
      color.setAttribute('aria-label', `Change ${type.id} panel color`);
      color.addEventListener('click', () => this.openColorPicker({ kind: 'type', id: type.id }, type.color, 'Change panel color'));
      entry.appendChild(color);
    }
    if (type.custom) {
      const trash = document.createElement('button');
      trash.className = 'icon-trash';
      trash.type = 'button';
      trash.innerHTML = TRASH_ICON;
      trash.title = 'Remove custom panel type';
      trash.setAttribute('aria-label', `Remove ${type.id} panel type`);
      trash.addEventListener('click', () => this.openReplacementDialog(type));
      entry.appendChild(trash);
    }
    return entry;
  }

  private openReplacementDialog(type: PanelType): void {
    const title = document.createElement('h2');
    title.textContent = `Replace ${type.id} panels`;
    const body = document.createElement('p');
    body.textContent = 'Choose a replacement type for panels already in the assembly.';
    const choices = document.createElement('div');
    choices.className = 'replacement-choices';
    for (const replacement of this.types.values()) {
      if (replacement.id === type.id) continue;
      const choice = document.createElement('button');
      choice.className = 'replacement-choice';
      choice.type = 'button';
      const swatch = document.createElement('span');
      swatch.className = `icon icon-${replacement.kind}`;
      swatch.style.setProperty('--swatch', replacement.color);
      const label = document.createElement('span');
      label.textContent = replacement.id;
      choice.append(swatch, label);
      choice.addEventListener('click', () => {
        this.cbs.onRemoveType(type.id, replacement.id);
        this.replacementDialog.close();
      });
      choices.appendChild(choice);
    }
    const discard = document.createElement('button');
    discard.className = 'replacement-discard';
    discard.type = 'button';
    discard.textContent = '× Remove custom panels';
    discard.addEventListener('click', () => {
      this.cbs.onRemoveType(type.id, null);
      this.replacementDialog.close();
    });
    this.replacementDialog.replaceChildren(title, body, choices, discard);
    this.replacementDialog.showModal();
  }

  setQuickMode(enabled: boolean, notify = true): void {
    this.quickBtn.setAttribute('aria-pressed', String(enabled));
    this.quickBtn.setAttribute('aria-label', `Quick build: ${enabled ? 'On' : 'Off'}`);
    this.quickBtn.title = `Quick build: ${enabled ? 'On' : 'Off'}`;
    this.quickBtn.innerHTML = `${ICON('bolt')}<span>Quick build: ${enabled ? 'On' : 'Off'}</span>`;
    this.quickBtn.classList.toggle('active', enabled);
    if (notify) this.cbs.onQuickModeChange(enabled);
  }

  updateMaterials(metalColor: string, connectorColor: string): void {
    this.materialButtons.get('metal')?.style.setProperty('--swatch', metalColor);
    this.materialButtons.get('connector')?.style.setProperty('--swatch', connectorColor);
  }

  updateTypes(types: Map<string, PanelType>, activeId: string): void {
    this.types = new Map(types);
    this.typeList.replaceChildren();
    for (const type of types.values()) this.typeList.appendChild(this.makeTypeEntry(type, type.id === activeId));
  }

  setAssemblyCounts(types: Map<string, PanelType>, panels: Map<string, Panel>, connectorCount: number): void {
    const counts: CountType[] = [...types.values()].map((type) => ({ ...type, count: [...panels.values()].filter((panel) => panel.typeId === type.id).length }));
    this.countBar.replaceChildren();
    for (const type of counts) {
      const item = document.createElement('span');
      item.className = 'count-item';
      item.title = `${type.id}: ${type.count} panels`;
      const icon = document.createElement('span');
      icon.className = `count-icon icon icon-${type.kind}`;
      icon.style.setProperty('--swatch', type.color);
      const count = document.createElement('strong');
      count.textContent = String(type.count);
      item.append(icon, count);
      this.countBar.appendChild(item);
    }
    const divider = document.createElement('span');
    divider.className = 'count-divider';
    const connectors = document.createElement('span');
    connectors.className = 'count-item connector-count';
    connectors.title = `Connectors: ${connectorCount}`;
    connectors.innerHTML = `<i class="connector-count-icon fa-solid fa-puzzle-piece" aria-hidden="true"></i><strong>${connectorCount}</strong>`;
    this.countBar.append(divider, connectors);
    this.countBar.setAttribute('aria-label', `${counts.map((type) => `${type.id}: ${type.count}`).join(', ')}; connectors: ${connectorCount}`);
  }

  setSizeMode(mode: SizeMode): void {
    for (const { el, mode: m } of this.sizeButtons) el.classList.toggle('active', m === mode);
  }

  setTableActive(len: number): void {
    for (const { el, len: l } of this.tableButtons) el.classList.toggle('active', len === l);
  }

  setSelectedTrash(pos: { x: number; y: number; visible: boolean }): void {
    this.selectedTrash.classList.toggle('visible', pos.visible);
    if (pos.visible) {
      this.selectedTrash.style.left = `${pos.x}px`;
      this.selectedTrash.style.top = `${pos.y}px`;
    }
  }
}
