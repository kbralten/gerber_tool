import './style.css';
import JSZip from 'jszip';
import { createParser } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { render } from '@tracespace/renderer';
import { toHtml } from 'hast-util-to-html';
import { contours } from 'd3-contour';
import { parseDrillToSvg, isDrillFile } from './drill-parser';

// --- Layer Color Palette ---
const LAYER_COLORS: Record<string, string> = {
  copper:      '#f59e0b',
  soldermask:  '#10b981',
  silkscreen:  '#f8fafc',
  paste:       '#94a3b8',
  drill:       '#ef4444',
  outline:     '#a855f7',
  other:       '#3b82f6',
};

const LAYER_ICONS: Record<string, string> = {
  copper:      '⬡',
  soldermask:  '◼',
  silkscreen:  '✦',
  paste:       '◈',
  drill:       '⊙',
  outline:     '⬜',
  other:       '◇',
};

// --- Types ---
interface LayerData {
  id: string;
  filename: string;
  type: string;
  svgString: string;
  visible: boolean;
  filetype: string;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] in native units
  units: 'in' | 'mm';
  color: string;
}

// --- State ---
const state = {
  layers: [] as LayerData[],
  globalBBox: null as [number, number, number, number] | null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  draggedLayerId: null as string | null, // For layer reordering
};

// --- DOM Elements ---
const dropZone    = document.getElementById('drop-zone')       as HTMLDivElement;
const fileInput   = document.getElementById('file-input')      as HTMLInputElement;
const layersList  = document.getElementById('layers-list')     as HTMLDivElement;
const canvasCont  = document.getElementById('canvas-container') as HTMLDivElement;
const toast       = document.getElementById('toast')           as HTMLDivElement;
const viewerTools = document.getElementById('viewer-tools')    as HTMLDivElement;
const zoomInBtn   = document.getElementById('zoom-in')         as HTMLButtonElement;
const zoomOutBtn  = document.getElementById('zoom-out')        as HTMLButtonElement;
const resetBtn    = document.getElementById('reset-view')      as HTMLButtonElement;

// --- Boot ---
document.addEventListener('DOMContentLoaded', () => {
  setupDragAndDrop();
  setupPanAndZoom();
  setupBrowseButton();
});

// --- Drag & Drop ---
function setupDragAndDrop() {
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      dropZone.classList.remove('hidden');
    }
  }, false);

  window.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); }, false);
  window.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); }, false);

  dropZone.addEventListener('dragleave', (e) => {
    if (e.target === dropZone) dropZone.classList.add('hidden');
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('hidden');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await processFiles(Array.from(files));
    }
  }, false);
}

function setupBrowseButton() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'browse-btn' || target.id === 'add-more-btn') {
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', async () => {
    if (fileInput.files && fileInput.files.length > 0) {
      await processFiles(Array.from(fileInput.files));
      fileInput.value = '';
    }
  });
}

// --- File Processing ---
async function processFiles(files: File[]) {
  showLoading();
  const before = state.layers.length;
  try {
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        await processZip(file);
      } else {
        await processGerberText(file.name, await file.text());
      }
    }
    const added = state.layers.length - before;
    if (added > 0) {
      showToast(`Loaded ${added} layer${added === 1 ? '' : 's'}.`);
    } else {
      showToast('No supported Gerber/drill files found.');
    }
  } catch (err) {
    console.error(err);
    showToast('Error: ' + (err as Error).message);
  } finally {
    hideLoading();
    updateUI();
  }
}

async function processZip(file: File) {
  const zip = new JSZip();
  const contents = await zip.loadAsync(file);
  const tasks: Promise<void>[] = [];
  contents.forEach((relativePath, entry) => {
    if (entry.dir || relativePath.includes('__MACOSX') || relativePath.startsWith('.')) return;
    tasks.push(entry.async('string').then((text) => processGerberText(entry.name, text)));
  });
  await Promise.allSettled(tasks);
}

// Guess layer type from filename extension/keyword
function guessLayerType(filename: string): string {
  const n = filename.toLowerCase();

  // KiCad-style underscore-separated layer names (e.g. -F_Cu.gbr, -B_Paste.gbr)
  if (/_f_cu\.gbr$|_b_cu\.gbr$|_in\d+_cu\.gbr$/.test(n)) return 'copper';
  if (/_f_mask\.gbr$|_b_mask\.gbr$/.test(n)) return 'soldermask';
  if (/_f_silkscreen\.gbr$|_b_silkscreen\.gbr$|_f_silk\.gbr$|_b_silk\.gbr$/.test(n)) return 'silkscreen';
  if (/_f_paste\.gbr$|_b_paste\.gbr$/.test(n)) return 'paste';
  if (/_edge_cuts\.gbr$|_board_outline\.gbr$/.test(n)) return 'outline';

  // Extension-based classic Gerber extensions
  if (n.endsWith('.drl') || n.endsWith('drill.txt') || n.endsWith('-drill.txt') ||
      (n.endsWith('.txt') && (n.includes('drill') || n.includes('nc')))) return 'drill';
  if (n.endsWith('.gbl') || n.endsWith('.cul')) return 'copper';
  if (n.endsWith('.gtl') || n.endsWith('.cur')) return 'copper';
  if (n.endsWith('.gbs') || n.endsWith('.sml')) return 'soldermask';
  if (n.endsWith('.gts') || n.endsWith('smu')) return 'soldermask';
  if (n.endsWith('.gbo')) return 'silkscreen';
  if (n.endsWith('.gto')) return 'silkscreen';
  if (n.endsWith('.gbp') || n.endsWith('.spa')) return 'paste';
  if (n.endsWith('.gtp') || n.endsWith('.sps')) return 'paste';
  if (n.endsWith('.gko') || n.endsWith('.gm1')) return 'outline';
  if (n.endsWith('.exc') || n.endsWith('.xln')) return 'drill';

  // Keyword-based fallbacks
  if (n.includes('edge') || n.includes('outline') || n.includes('border')) return 'outline';
  if (n.includes('drill') || n.includes('_npth') || n.includes('_pth')) return 'drill';
  if (n.includes('silk') || n.includes('overlay')) return 'silkscreen';
  if (n.includes('mask')) return 'soldermask';
  if (n.includes('paste')) return 'paste';
  if (n.includes('copper') || n.includes('_cu') || n.includes('-cu')) return 'copper';

  // .gbr with no other clue → generic copper
  if (n.endsWith('.gbr')) return 'copper';

  return 'other';
}

async function processGerberText(filename: string, content: string) {
  const shortName = filename.split('/').pop() || filename;
  try {
    let svgString: string;
    let nativeBBox: [number, number, number, number];
    let units: 'in' | 'mm' = 'in';

    const layerType = guessLayerType(filename);
    const existingCount = state.layers.filter(l => l.type === layerType).length;
    let color = LAYER_COLORS[layerType] ?? LAYER_COLORS.other;
    
    // Shift color if multiple of the same type exist
    if (existingCount > 0) {
      color = getShiftedColor(color, existingCount);
    }

    // --- Try custom drill parser first for known drill file formats ---
    if (isDrillFile(filename, content)) {
      const result = parseDrillToSvg(content, color);
      if (result) {
        svgString = result.svg;
        nativeBBox = result.bbox;
        units = 'mm';
        state.layers.push({
          id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          filename: shortName,
          type: 'drill',
          svgString,
          visible: true,
          filetype: 'drill',
          bbox: nativeBBox,
          units,
          color,
        });
        updateGlobalBBox();
        return;
      }
    }

    // --- Standard Gerber via tracespace ---
    // Strip Gerber X2 net-attribute extensions (%TO.*% %TD*%) which tracespace
    // doesn't implement - they are metadata-only and removing them is safe.
    const cleanContent = content.replace(/%TO[^%]*%/g, '').replace(/%TD[^%]*%/g, '');

    const parser = createParser();
    parser.feed(cleanContent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ast = parser.results() as any;
    if (!ast || !ast.children || ast.children.length === 0) {
      console.warn(`Skipping empty/unrecognized file: ${shortName}`);
      return;
    }

    // Patch AST to fix compatibility between @tracespace/parser@next.0 and @tracespace/plotter@alpha.0
    function patchAst(node: any) {
      if (node.children) node.children.forEach(patchAst);
      if (node.blocks) node.blocks.forEach(patchAst);
      
      if (node.type === 'toolDefinition' && node.shape?.type === 'macroShape') {
        if (node.shape.params && !node.shape.variableValues) {
          node.shape.variableValues = node.shape.params;
        }
      }
      if (node.type === 'macroPrimitive') {
        if (node.modifiers && !node.parameters) {
          node.parameters = node.modifiers;
        }
      }
    }
    patchAst(ast);

    // Determine units: tracespace's ast.units can be undefined for some KiCad files
    // even when the file contains %MOMM*%. Fall back to regex on raw content.
    if (ast.units === 'mm') {
      units = 'mm';
    } else if (ast.units === 'in') {
      units = 'in';
    } else {
      // Fallback: scan file for %MOMM% or %MOIN% header commands
      units = /%MO\s*MM/i.test(cleanContent) ? 'mm' : 'in';
    }


    // Plot the image tree; if plot() crashes (e.g. unsupported aperture macros),
    // retry after stripping macro blocks from the source and re-parsing
    let imageTree;
    try {
      imageTree = plot(ast);
    } catch (_plotErr) {
      console.warn(`plot() failed for ${shortName}, retrying after stripping aperture macros...`);
      // Extract macro names defined via %AM...%
      const macroNames = [...cleanContent.matchAll(/%AM([^*]+)\*/g)].map(m => m[1]);
      // Strip only the apertures that reference the macros, leaving the %AM definitions intact.
      // Tracespace crashes if an %AM is missing, but is fine if it's defined and unused.
      let saferContent = cleanContent;
      for (const macroName of macroNames) {
        // Remove %ADDxx<MacroName>,... *% lines
        const escaped = macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        saferContent = saferContent.replace(new RegExp(`%ADD\\d+${escaped}[^%]*%`, 'g'), '');
      }
      const parser2 = createParser();
      parser2.feed(saferContent);
      const ast2 = parser2.results() as any;
      if (!ast2 || !ast2.children || ast2.children.length === 0) {
        console.warn(`Skipping ${shortName}: no recoverable content after macro strip`);
        return;
      }
      patchAst(ast2);
      units = (ast2.units === 'mm') ? 'mm' : 'in';
      imageTree = plot(ast2);
    }

    nativeBBox = imageTree.size as [number, number, number, number];

    // If the image is empty (no graphics), skip gracefully
    if (!nativeBBox || nativeBBox.every(v => v === 0) || (nativeBBox[2] - nativeBBox[0] === 0 && nativeBBox[3] - nativeBBox[1] === 0)) {
      console.warn(`Skipping layer with empty bounds: ${shortName}`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svgHast = render(imageTree) as any;
    svgString = toHtml(svgHast, { space: 'svg' });

    state.layers.push({
      id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      filename: shortName,
      type: layerType,
      svgString: svgString,
      visible: true,
      filetype: ast.filetype ?? 'unknown',
      bbox: nativeBBox,
      units,
      color,
    });
    updateGlobalBBox();
  } catch (err) {
    console.warn(`Failed to render ${shortName}:`, err);
  }
}

// Helper to shift a hex color's hue
function getShiftedColor(hex: string, index: number): string {
  // Convert hex to RGB
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.substring(1, 3), 16);
    g = parseInt(hex.substring(3, 5), 16);
    b = parseInt(hex.substring(5, 7), 16);
  }
  
  // Convert RGB to HSL
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  // Shift hue (or adjust lightness if grayscale like white/grey)
  if (s < 0.1) {
    // If it's grayscale (e.g. silkscreen), just darken/lighten it a bit
    l = Math.max(0.2, l - (index * 0.15));
    // add a tiny bit of saturation and hue shift so it's not strictly grey forever
    s = 0.3;
    h = (index * 0.1) % 1.0;
  } else {
    // Shift hue by ~45 degrees (0.125) per index
    h = (h + (index * 0.15)) % 1.0;
    // Vary lightness slightly to add distinction
    l = Math.max(0.3, Math.min(0.7, l + (index % 2 === 0 ? 0.1 : -0.1)));
  }

  // Convert HSL back to RGB
  let r2, g2, b2;
  if (s === 0) {
    r2 = g2 = b2 = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r2 = hue2rgb(p, q, h + 1/3);
    g2 = hue2rgb(p, q, h);
    b2 = hue2rgb(p, q, h - 1/3);
  }

  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  
  return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
}

function updateGlobalBBox() {
  if (state.layers.length === 0) {
    state.globalBBox = null;
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.layers.forEach(l => {
    const scale = l.units === 'in' ? 25.4 : 1.0;
    minX = Math.min(minX, l.bbox[0] * scale);
    minY = Math.min(minY, l.bbox[1] * scale);
    maxX = Math.max(maxX, l.bbox[2] * scale);
    maxY = Math.max(maxY, l.bbox[3] * scale);
  });
  state.globalBBox = [minX, minY, maxX, maxY];
}

// --- UI ---
function updateUI() {
  renderSidebar();
  renderCanvas();
}

function renderSidebar() {
  if (state.layers.length === 0) {
    layersList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <p>Drop or browse for<br>.gbr, .drl, or .zip files</p>
        <button id="browse-btn" class="primary-btn">Browse Files</button>
        <input type="file" id="file-input" multiple accept=".gbr,.drl,.gbl,.gtl,.gbs,.gts,.gko,.gbrjob,.txt,.zip" class="hidden-input" />
      </div>`;
    viewerTools.classList.add('hidden');
    return;
  }

  let html = '<div class="layers-header"><span>Toggle All</span><label class="toggle-switch"><input type="checkbox" id="toggle-all" checked><span class="slider"></span></label></div>';

  for (const layer of state.layers) {
    const color = layer.color;
    const icon = LAYER_ICONS[layer.type] ?? '◇';
    html += `
      <div class="layer-item" data-id="${layer.id}" draggable="true">
        <div class="layer-drag-handle">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
        </div>
        <div class="layer-info" title="${layer.filename}">
          <span class="layer-color-dot" style="background:${color}"></span>
          <span class="layer-icon">${icon}</span>
          <div class="layer-text">
            <span class="layer-name">${layer.filename}</span>
            <span class="layer-type-badge">${layer.type}</span>
          </div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-id="${layer.id}" ${layer.visible ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>`;
  }

  html += `<div class="sidebar-actions">
    <button id="add-more-btn" class="secondary-btn">+ Add</button>
    <button id="export-svg-btn" class="primary-btn" style="margin-top:0; flex:1; padding: 8px 6px; font-size: 0.85rem;">Export</button>
    <button id="clear-all-btn" class="danger-btn">Clear</button>
  </div>`;

  layersList.innerHTML = html;
  viewerTools.classList.remove('hidden');

  // Bind toggles
  layersList.querySelectorAll<HTMLInputElement>('input[data-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const layer = state.layers.find(l => l.id === cb.getAttribute('data-id'));
      if (layer) { layer.visible = cb.checked; renderCanvas(); }
    });
  });

  // Bind Layer Reordering Drag & Drop
  const items = layersList.querySelectorAll<HTMLDivElement>('.layer-item');
  items.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      const id = item.getAttribute('data-id');
      if (id) {
        state.draggedLayerId = id;
        item.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
        }
      }
    });

    item.addEventListener('dragend', () => {
      state.draggedLayerId = null;
      item.classList.remove('dragging');
      items.forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault(); // Necessary to allow dropping
      if (!state.draggedLayerId || state.draggedLayerId === item.getAttribute('data-id')) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      const rect = item.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      // Determine if dragging over top half or bottom half
      if (relY < rect.height / 2) {
        item.classList.add('drag-over-top');
        item.classList.remove('drag-over-bottom');
      } else {
        item.classList.add('drag-over-bottom');
        item.classList.remove('drag-over-top');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      const draggedId = state.draggedLayerId;
      const targetId = item.getAttribute('data-id');
      if (!draggedId || !targetId || draggedId === targetId) return;

      const draggedIndex = state.layers.findIndex(l => l.id === draggedId);
      const targetIndex = state.layers.findIndex(l => l.id === targetId);
      if (draggedIndex === -1 || targetIndex === -1) return;

      const rect = item.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      let newIndex = targetIndex;
      if (relY >= rect.height / 2) {
         // Insert after
         newIndex++;
      }
      
      // Moving downwards vs upwards affects the insertion index if we remove first
      if (draggedIndex < newIndex) {
        newIndex--; // We are removing an element before the new index
      }

      const [draggedLayer] = state.layers.splice(draggedIndex, 1);
      state.layers.splice(newIndex, 0, draggedLayer);
      updateUI();
    });
  });

  const toggleAll = document.getElementById('toggle-all') as HTMLInputElement;
  toggleAll?.addEventListener('change', () => {
    state.layers.forEach(l => { l.visible = toggleAll.checked; });
    layersList.querySelectorAll<HTMLInputElement>('input[data-id]').forEach(cb => { cb.checked = toggleAll.checked; });
    renderCanvas();
  });

  document.getElementById('clear-all-btn')?.addEventListener('click', () => {
    state.layers = [];
    state.globalBBox = null;
    state.zoom = 1; state.panX = 0; state.panY = 0;
    updateUI();
    showToast('All layers cleared.');
  });

  document.getElementById('export-svg-btn')?.addEventListener('click', exportSvg);
}

function renderCanvas() {
  canvasCont.innerHTML = '';

  const visibleLayers = state.layers.filter(l => l.visible);
  if (visibleLayers.length === 0 || !state.globalBBox) return;

  const [minX, minY, maxX, maxY] = state.globalBBox;
  const width = maxX - minX;
  const height = maxY - minY;
  const globalViewBox = `${minX} ${minY} ${width} ${height}`;

  // Create a root SVG wrapper
  const wrapper = document.createElement('div');
  wrapper.id = 'transform-wrapper';
  wrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  wrapper.style.transformOrigin = 'center center';
  wrapper.style.position = 'absolute';
  wrapper.style.top = '0';
  wrapper.style.left = '0';
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.display = 'block';

  // Render each visible layer
  visibleLayers.forEach((layer) => {
    const color = layer.color;
    const div = document.createElement('div');
    div.className = 'layer-svg-wrap';
    div.innerHTML = layer.svgString;

    const svgEl = div.querySelector('svg');
    if (svgEl) {
      // OVERRIDE ViewBox to the Global Bounding Box for perfect alignment
      svgEl.setAttribute('viewBox', globalViewBox);
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      
      const globalSumMM    = maxY + minY;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      
      if (layer.type === 'drill') {
        // Drills: raw Y-up MM coordinates -> global SVG Y-down
        g.setAttribute('transform', `translate(0, ${globalSumMM}) scale(1, -1)`);
      } else {
        // Gerbers: Tracespace outputs y_svg = -y_native.
        // We want y_final = globalSumMM - y_native_mm.
        // Therefore, y_final = globalSumMM + y_svg_mm.
        if (layer.units === 'in') {
          // If inches, scale internal coordinates by 25.4
          g.setAttribute('transform', `translate(0, ${globalSumMM}) scale(25.4)`);
        } else {
          g.setAttribute('transform', `translate(0, ${globalSumMM})`);
        }
      }

      // Move all children except potentially <defs> to the new group
      // Moving all nodes is usually fine even for defs, but let's be safe.
      while (svgEl.firstChild) {
        g.appendChild(svgEl.firstChild);
      }
      svgEl.appendChild(g);

      // Make SVG fill the container
      svgEl.style.width = '100%';
      svgEl.style.height = '100%';
      svgEl.style.display = 'block';
      svgEl.style.overflow = 'visible';
      svgEl.style.color = color;
      svgEl.setAttribute('fill', color);

      // Walk and colorize paths
      svgEl.querySelectorAll('path, rect, circle, polygon, polyline').forEach(el => {
        const fillVal = el.getAttribute('fill');
        if (fillVal && fillVal !== 'none' && fillVal !== 'transparent') {
          el.setAttribute('fill', color);
        }
        const strokeVal = el.getAttribute('stroke');
        if (strokeVal && strokeVal !== 'none') {
          el.setAttribute('stroke', color);
        }
      });
    }


    div.style.position = 'absolute';
    div.style.top = '0';
    div.style.left = '0';
    div.style.width = '100%';
    div.style.height = '100%';
    div.style.mixBlendMode = 'screen';
    div.style.pointerEvents = 'none';

    wrapper.appendChild(div);
  });

  canvasCont.appendChild(wrapper);
}

// --- Pan & Zoom ---
function setupPanAndZoom() {
  canvasCont.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.9;
    state.zoom = Math.max(0.05, Math.min(20, state.zoom * factor));
    applyTransform();
  }, { passive: false });

  canvasCont.addEventListener('mousedown', (e) => {
    state.isDragging = true;
    state.dragStartX = e.clientX - state.panX;
    state.dragStartY = e.clientY - state.panY;
    canvasCont.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isDragging) return;
    state.panX = e.clientX - state.dragStartX;
    state.panY = e.clientY - state.dragStartY;
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    canvasCont.style.cursor = 'grab';
  });

  zoomInBtn?.addEventListener('click', () => {
    state.zoom = Math.min(20, state.zoom * 1.5);
    applyTransform();
  });
  zoomOutBtn?.addEventListener('click', () => {
    state.zoom = Math.max(0.05, state.zoom / 1.5);
    applyTransform();
  });
  resetBtn?.addEventListener('click', () => {
    state.zoom = 1; state.panX = 0; state.panY = 0;
    applyTransform();
  });
}

function applyTransform() {
  const wrapper = document.getElementById('transform-wrapper');
  if (wrapper) {
    wrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  }
}

// --- Utils ---
function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.remove('hidden', 'show');
  void toast.offsetWidth; // reflow
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 400);
  }, 3000);
}

function showLoading() {
  if (document.getElementById('loading-overlay')) return;
  const el = document.createElement('div');
  el.id = 'loading-overlay';
  el.className = 'loading-overlay';
  el.innerHTML = `<div class="spinner"></div><span>Processing files…</span>`;
  document.body.appendChild(el);
}

function hideLoading() {
  document.getElementById('loading-overlay')?.remove();
}

/** 
 * Promisify loading an image from an SVG string 
 */
function loadImageDataFromSvg(svgString: string, width: number, height: number): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve(null);
      // Fill white background to trace black/dark areas if needed, or just let transparent be transparent
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(ctx.getImageData(0, 0, width, height));
    };
    img.onerror = () => resolve(null);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.src = url;
  });
}

/**
 * Builds SVG path 'd' string from GeoJSON MultiPolygon coordinates
 */
function geoJsonToSvgPath(coordinates: number[][][][]): string {
  let d = '';
  for (const polygon of coordinates) {
    for (let i = 0; i < polygon.length; i++) {
      const ring = polygon[i];
      if (ring.length === 0) continue;
      d += `M ${ring[0][0]},${ring[0][1]} `;
      for (let j = 1; j < ring.length; j++) {
        d += `L ${ring[j][0]},${ring[j][1]} `;
      }
      d += 'Z ';
    }
  }
  return d;
}

async function exportSvg() {
  const visibleLayers = state.layers.filter(l => l.visible);
  if (visibleLayers.length === 0 || !state.globalBBox) {
    showToast('No layers to export.');
    return;
  }

  showLoading();

  try {
    const [minX, minY, maxX, maxY] = state.globalBBox;
    const globalWidth = maxX - minX;
    const globalHeight = maxY - minY;
    const globalViewBox = `${minX} ${minY} ${globalWidth} ${globalHeight}`;

    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${globalViewBox}" width="100%" height="100%">\n`;

    // Resolution: pixels per mm
    const resolution = 80; 
    const pxWidth = Math.ceil(globalWidth * resolution);
    const pxHeight = Math.ceil(globalHeight * resolution);
    const globalSumMM = maxY + minY;

    for (const layer of visibleLayers) {
      const color = layer.color;

      // Create a temporary SVG that renders the layer filled with black on transparent background
      // so we can easily threshold the alpha channel.
      const div = document.createElement('div');
      div.innerHTML = layer.svgString;
      const parsedSvgNode = div.querySelector('svg');
      if (!parsedSvgNode) continue;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      if (layer.type === 'drill') {
        g.setAttribute('transform', `translate(0, ${globalSumMM}) scale(1, -1)`);
      } else {
        if (layer.units === 'in') {
          g.setAttribute('transform', `translate(0, ${globalSumMM}) scale(25.4)`);
        } else {
          g.setAttribute('transform', `translate(0, ${globalSumMM})`);
        }
      }

      while (parsedSvgNode.firstChild) {
        g.appendChild(parsedSvgNode.firstChild);
      }
      parsedSvgNode.appendChild(g);

      // Force everything to black so alpha is strong
      parsedSvgNode.querySelectorAll('path, rect, circle, polygon, polyline').forEach(el => {
        const fillVal = el.getAttribute('fill');
        if (fillVal && fillVal !== 'none' && fillVal !== 'transparent') {
          el.setAttribute('fill', '#000000');
        }
        const strokeVal = el.getAttribute('stroke');
        if (strokeVal && strokeVal !== 'none') {
          el.setAttribute('stroke', '#000000');
        }
      });

      // Wrap it in a proper sized SVG string for canvas rasterization
      parsedSvgNode.setAttribute('viewBox', globalViewBox);
      parsedSvgNode.setAttribute('width', pxWidth.toString());
      parsedSvgNode.setAttribute('height', pxHeight.toString());
      
      const xmlSerializer = new XMLSerializer();
      const blackSvgString = xmlSerializer.serializeToString(parsedSvgNode);

      const imgData = await loadImageDataFromSvg(blackSvgString, pxWidth, pxHeight);
      if (!imgData) continue;

      // Extract alpha channel
      const values = new Array(pxWidth * pxHeight);
      for (let i = 0, n = pxWidth * pxHeight; i < n; ++i) {
        values[i] = imgData.data[i * 4 + 3]; // Alpha channel (0-255)
      }

      // Trace contours using d3-contour (threshold at alpha=128)
      const contourList = contours()
        .size([pxWidth, pxHeight])
        .thresholds([128])
        (values);

      // Add paths to final SVG, converting contour pixel coordinates back to native mm
      svgContent += `  <g class="layer-wrap" fill="${color}" stroke="${color}" stroke-width="0.01">\n`;
      
      for (const contour of contourList) {
        if (!contour.coordinates || contour.coordinates.length === 0) continue;
        
        // Scale down to mm and translate back to [minX, minY]
        const nativeCoordinates = contour.coordinates.map(polygon => 
          polygon.map(ring => 
            ring.map(point => [
              (point[0] / resolution) + minX,
              (point[1] / resolution) + minY
            ])
          )
        );

        const pathData = geoJsonToSvgPath(nativeCoordinates);
        if (pathData) {
          svgContent += `    <path d="${pathData}" />\n`;
        }
      }
      
      svgContent += `  </g>\n`;
    }

    svgContent += `</svg>`;

    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gerber-export.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Exported SVG successfully.');
  } catch (err) {
    console.error("Export failed:", err);
    showToast('Export failed. Check console.');
  } finally {
    hideLoading();
  }
}

