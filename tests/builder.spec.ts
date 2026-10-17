import { expect, test, type Page } from '@playwright/test';

// State seam exposed by the app (read-only): panels, connectors, camera, debug pick.
interface Builder {
  world: {
    panels: Map<string, { plane: string; i: number; j: number; k: number; typeId: string }>;
    connectors: Map<string, { plane: string; sign: number }>;
    types: Map<string, { id: string; custom: boolean }>;
    activeTypeId: string;
    selectedKey: string | null;
    tableLength: number;
    candidates(): Array<{ plane: string; i: number; j: number; k: number }>;
  };
  sceneCtx: {
    camera: { position: { toArray(): number[] } };
    controls: { target: { toArray(): number[] } };
    ghostGroup: { children: unknown[] };
    markerGroup: { children: unknown[] };
    panelGroup: { children: unknown[] };
  };
  debug: {
    info(): {
      hoverPanelKey: string | null;
      ghostPlacement: { plane: string; i: number; j: number; k: number } | null;
    };
  };
}

async function builder(page: Page): Promise<Builder> {
  return await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder);
}

async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('#viewport canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#viewport canvas');
  // Legacy hover/click specs below deliberately exercise Quick build. New
  // normal-mode coverage explicitly toggles this back off.
  await page.locator('.quick-mode-btn').click();
});
test('compact share link restores panels and is far smaller than JSON', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#viewport canvas');
  const codec = await page.evaluate(async () => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    // Build a mixed assembly: 16 std decks + 4 standing 16-talls.
    for (let k = -2; k <= 1; k++) {
      for (let i = 0; i < 4; i++) {
        // Alternate deck rows between std-deep and 16-deep decks.
        void b.world.place({ plane: 'y', i, j: 0, k, span: k % 2 === 0 ? [12, 16] : [12, 12] }, 'plain', true);
      }
    }
    for (let i = 0; i < 4; i++) void b.world.place({ plane: 'z', i, j: 0, k: 0, span: [12, 16] }, 'plain', true);
    const state = b.world.toJSON();
    state.metalColor = '#7a3e2a';
    const packed = await b.codec.encode(state);
    const decoded = await b.codec.decode(packed);
    return { packed, json: JSON.stringify(state), decoded, panels: state.panels.length };
  });
  expect(codec.packed.startsWith('Q1VC')).toBe(true); // 'CUB' base64url prefix
  expect(codec.packed.length).toBeLessThan(codec.json.length / 4);
  expect(codec.decoded).not.toBeNull();
  expect(codec.decoded?.panels).toHaveLength(codec.panels);
  expect(codec.decoded?.metalColor).toBe('#7a3e2a');

  // A packed fragment restores the full assembly after reload.
  await page.goto(`/#assembly=${codec.packed}`);
  await page.waitForSelector('#viewport canvas');
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.panels.size);
  expect(restored).toBe(codec.panels);
});

test('sidebar shows the 3 default panel types without remove buttons', async ({ page }) => {
  const ids = await page.locator('.type-btn').evaluateAll((els) => els.map((el) => el.getAttribute('data-type-id')));
  expect(ids).toEqual(['plain', 'grid', 'outline']);
  const trashCount = await page.locator('.type-btn .icon-trash').count();
  expect(trashCount).toBe(0);
});

test('bug export button copies a complete assembly JSON snapshot', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.assemblyJson = text;
        },
      },
    });
  });

  await page.locator('.dump-state-btn').click();
  await expect.poll(() => page.locator('html').getAttribute('data-assembly-json')).not.toBeNull();
  const copied = JSON.parse(await page.locator('html').getAttribute('data-assembly-json')!);

  expect(copied).toMatchObject({
    version: 1,
    tableLength: 72,
    activeTypeId: 'plain',
    selectedKey: null,
  });
  expect(copied.types.map((type: { id: string }) => type.id)).toEqual(['plain', 'grid', 'outline']);
  expect(copied.panels).toEqual([]);
  expect(copied.connectors).toEqual([]);
});

test('hovering the table shows a flat-panel ghost with four face-up connectors', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.55, { steps: 3 });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.ghostGroup.children.length)
    )
    .toBe(2); // ghost renders as one group (panel + connectors) + one mesh
  const ghost = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.debug.info());
  expect(ghost.ghostPlacement).toMatchObject({ plane: 'y', j: 0 });
});

test('clicking the table places a flat active panel with four face-up connectors', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.55, { steps: 3 });
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(150);

  const state = await page.evaluate(() => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    return { panels: [...b.world.panels.values()], connectors: [...b.world.connectors.values()] };
  });
  expect(state.panels).toHaveLength(1);
  expect(state.panels[0]).toMatchObject({ plane: 'y', j: 0 });
  expect(state.connectors).toHaveLength(4);
  expect(state.connectors).toEqual(
    expect.arrayContaining(Array.from({ length: 4 }, () => expect.objectContaining({ plane: 'y', sign: 1 })))
  );
  expect(await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.candidates().length)).toBeGreaterThan(0);
});

test('flat table panel exposes a coplanar continuation candidate', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.55, { steps: 3 });
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(150);

  const target = await page.evaluate(() => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    const panel = [...b.world.panels.values()][0];
    return b.world.candidates().find(
      (candidate) => candidate.plane === 'y' && candidate.i === panel.i + 1
        && candidate.j === panel.j && candidate.k === panel.k
    ) ?? null;
  });
  expect(target).not.toBeNull();
});

test('left click selects a placed panel and shows the center trash', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55); // place
  await page.waitForTimeout(200);
  await clickProjected(page, 'b.sceneCtx.panelGroup.children[0]'); // select via the panel's projected center
  await page.waitForTimeout(200);

  expect((await builder(page)).world.selectedKey).not.toBeNull();
  await expect(page.locator('.overlay-btn.visible')).toHaveCount(1);
});

test('trash overlay removes the selected panel and its connectors', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55); // place
  await page.waitForTimeout(200);
  await clickProjected(page, 'b.sceneCtx.panelGroup.children[0]'); // select
  await page.waitForTimeout(200);

  await page.locator('.overlay-btn.visible').click();
  await page.waitForTimeout(150);
  const counts = await page.evaluate(() => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    return { panels: b.world.panels.size, connectors: b.world.connectors.size };
  });
  expect(counts.panels).toBe(0);
  expect(counts.connectors).toBe(0);
});

test('right-clicking a placed panel removes it', async ({ page }) => {
  const box = await canvasBox(page);
  const x = box.x + box.width * 0.42;
  const y = box.y + box.height * 0.55;
  await page.mouse.click(x, y, { button: 'left' });
  await page.waitForTimeout(150);

  await page.mouse.click(x, y, { button: 'right' });
  await expect.poll(() =>
    page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.panels.size)
  ).toBe(0);
});

test('a click on an invalid edge ghost is rejected and reported', async ({ page }) => {
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') diagnostics.push(message.text());
  });

  const result = await page.evaluate(() => {
    const b = (window as unknown as { __builder: any }).__builder;
    const viewport = document.getElementById('viewport')!;
    const canvas = b.sceneCtx.renderer.domElement as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    // The scan below dispatches thousands of synthetic pointer events; stub
    // the WebGL draw so the scan stays logic-only and does not starve the
    // browser's renderer queue for the following tests in this worker.
    b.sceneCtx.renderer.render = () => {};
    const proj = (w: [number, number, number]) => {
      const o = { x: 0, y: 0, visible: false };
      b.sceneCtx.projectToScreen(w, o, viewport);
      return o.visible ? { x: o.x + rect.left, y: o.y + rect.top } : null;
    };
    const drive = (px: number, py: number, click: boolean) => {
      const opts = { bubbles: true, cancelable: true, clientX: Math.round(px), clientY: Math.round(py), button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      canvas.dispatchEvent(new PointerEvent('pointermove', opts));
      if (click) {
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
      }
      return b.debug.info();
    };

    const a = proj([42, 0, -6]);
    drive(a.x, a.y, true); // horizontal base panel
    if (b.world.panels.size !== 1) return { fail: 'base placement' as const };

    // A vertical panel: first valid non-horizontal ghost near the far-side edge
    const leftEdgeMid = proj([36, 0, -6]);
    let ghostPt: { x: number; y: number } | null = null;
    for (let dx = 4; dx <= 30 && !ghostPt; dx += 3) {
      for (let dy = -26; dy <= 26 && !ghostPt; dy += 4) {
        const d = drive(leftEdgeMid.x + dx, leftEdgeMid.y + dy, false);
        if (d.ghostPlacement && d.ghostPlacement.plane !== 'y' && !d.ghostInvalid) ghostPt = { x: leftEdgeMid.x + dx, y: leftEdgeMid.y + dy };
      }
    }
    if (!ghostPt) return { fail: 'no vertical ghost' as const };
    drive(ghostPt.x, ghostPt.y, true);
    if (b.world.panels.size !== 2) return { fail: 'vertical placement' as const };
    const vertical = [...b.world.panels.values()][1];

    // Latch the vertical panel's edges, then find an off-panel invalid ghost
    // (e.g. the below-table square) and click it: rejection + diagnostic.
    const anchors = vertical.plane === 'z'
      ? [proj([vertical.i * 12 + 6, 0, vertical.k * 12]), proj([vertical.i * 12 + 6, 0, vertical.k * 12 + 12]), proj([vertical.i * 12, 0, vertical.k * 12 + 6]), proj([vertical.i * 12 + 12, 0, vertical.k * 12 + 6])]
      : [proj([vertical.i, 0, vertical.k * 12 + 6]), proj([vertical.i + 12, 0, vertical.k * 12 + 6]), proj([vertical.i + 6, 0, vertical.k * 12]), proj([vertical.i + 6, 0, vertical.k * 12 + 12])];
    let clicked: { gp: unknown; before: number; after: number } | null = null;
    for (const anc of anchors.filter(Boolean)) {
      for (let dx = -45; dx <= 45 && !clicked; dx += 4) {
        for (let dy = -30; dy <= 30 && !clicked; dy += 4) {
          const d = drive(anc.x + dx, anc.y + dy, false);
          if (d.ghostPlacement && d.ghostInvalid && !d.pickedPanel) {
            const before = b.world.panels.size;
            const gp = d.ghostPlacement;
            drive(anc.x + dx, anc.y + dy, true);
            clicked = { gp, before, after: b.world.panels.size };
          }
        }
      }
    }
    return { vertical, clicked };
  });

  expect(result.fail).toBeUndefined();
  expect(result.clicked).not.toBeNull();
  expect(result.clicked!.before).toBe(2);
  expect(result.clicked!.after).toBe(2); // the invalid ghost click placed nothing
  await expect.poll(() => diagnostics.some((entry) => entry.includes('rejected-red-ghost-placement'))).toBe(true);
  const diagnostic = JSON.parse(diagnostics.find((entry) => entry.includes('rejected-red-ghost-placement'))!);
  expect(diagnostic).toMatchObject({
    event: 'rejected-red-ghost-placement',
    attempted: { action: 'place-panel', placement: result.clicked!.gp, panelTypeId: 'plain' },
    assembly: { panels: expect.any(Array), connectors: expect.any(Array) },
  });
});


test('clicking a sidebar type re-types the selected panel', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55); // place
  await page.waitForTimeout(200);
  await clickProjected(page, 'b.sceneCtx.panelGroup.children[0]'); // select
  await page.waitForTimeout(200);

  await page.locator('[data-type-id="grid"]').click();
  const panels = await page.evaluate(() => [...(window as unknown as { __builder: Builder }).__builder.world.panels.values()]);
  expect(panels[0].typeId).toBe('grid');
});

test('web color picker creates a custom type immediately', async ({ page }) => {
  await page.locator('#sidebar .add-btn').click();
  await expect(page.locator('.picker-dialog[open]')).toBeVisible();
  await page.locator('.palette-swatch[title="#ef4444"]').click();

  expect((await builder(page)).world.activeTypeId).toBe('custom-1');
  const customs = await page.locator('.type-entry.custom').count();
  expect(customs).toBe(1);
  expect(await page.locator('.type-entry.custom .icon-trash').count()).toBe(1);
  expect(await page.locator('.type-entry:not(.custom) .icon-trash').count()).toBe(0);
});

test('web color picker recolors default plain state', async ({ page }) => {
  await page.locator('.type-btn[data-type-id="plain"]').locator('..').locator('.type-color-btn').click();
  await page.locator('.palette-swatch[title="#3b82f6"]').click();
  const state = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.toJSON());
  expect(state.types.find((type) => type.id === 'plain')?.color).toBe('#3b82f6');
});

test('custom type deletion migrates its placed panels to the selected type', async ({ page }) => {
  await page.locator('#sidebar .add-btn').click();
  await page.locator('.palette-swatch[title="#ef4444"]').click();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
  await page.locator('.type-entry.custom').hover();
  await page.locator('.type-entry.custom .icon-trash').click();
  await expect(page.locator('.replacement-dialog[open]')).toBeVisible();
  await page.locator('.replacement-dialog').getByRole('button', { name: 'plain' }).click();

  const state = await page.evaluate(() => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    return { hasCustom: b.world.types.has('custom-1'), firstTypeId: [...b.world.panels.values()][0]?.typeId };
  });
  expect(state.hasCustom).toBe(false);
  expect(state.firstTypeId).toBe('plain');
});

test('red X removal discards panels of the deleted custom type', async ({ page }) => {
  await page.locator('#sidebar .add-btn').click();
  await page.locator('.palette-swatch[title="#22c55e"]').click();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
  await page.locator('.type-entry.custom').hover();
  await page.locator('.type-entry.custom .icon-trash').click();
  await page.locator('.replacement-discard').click();
  expect(await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.panels.size)).toBe(0);
});

test('hovering a placed custom panel does not show a 3D delete affordance', async ({ page }) => {
  await page.locator('#sidebar .add-btn').click();
  await page.locator('.palette-swatch[title="#ef4444"]').click();
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.55, { steps: 3 });
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
  await page.waitForTimeout(150);
  expect(await page.locator('.overlay-btn.visible').count()).toBe(0);
});

test('right-drag orbits the camera', async ({ page }) => {
  const before = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.camera.position.toArray());
  const box = await canvasBox(page);
  await page.mouse.move(box.x + 700, box.y + 400, { steps: 2 });
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + 820, box.y + 360, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const after = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.camera.position.toArray());
  expect(after[0]).not.toBeCloseTo(before[0], 3);
  expect(after[2]).not.toBeCloseTo(before[2], 3);
});

test('middle-drag pans the camera target', async ({ page }) => {
  const before = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.controls.target.toArray());
  const box = await canvasBox(page);
  await page.mouse.move(box.x + 640, box.y + 400, { steps: 2 });
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 720, box.y + 440, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  const after = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.controls.target.toArray());
  expect(after[0]).not.toBeCloseTo(before[0], 3);
});

test('mouse wheel zooms', async ({ page }) => {
  const before = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.camera.position.toArray());
  const box = await canvasBox(page);
  await page.mouse.move(box.x + 640, box.y + 400, { steps: 2 });
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, -120);
  const after = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.camera.position.toArray());
  const dist = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
  expect(dist(after)).toBeLessThan(dist(before));
});

test('ghost is hidden while the camera is being dragged', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.68, { steps: 3 });
  await page.waitForTimeout(150);
  const ghostCount = await page.evaluate(
    () => (window as unknown as { __builder: Builder }).__builder.sceneCtx.ghostGroup.children.length
  );
  expect(ghostCount).toBeGreaterThan(0);

  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.55 + 80, box.y + box.height * 0.7 - 30, { steps: 4 });
  expect(
    await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.ghostGroup.children.length)
  ).toBe(0);
  await page.mouse.up({ button: 'right' });
});

test('table size selector changes table length and camera target', async ({ page }) => {
  await page.locator('#table-selector button[data-len="96"]').click();
  const b = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.tableLength);
  expect(b).toBe(96);
  const target = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.controls.target.toArray());
  expect(target[0]).toBeCloseTo(48, 5); // center of the 8 ft table
  await expect(page.locator('#table-selector button[data-len="96"]')).toHaveClass(/active/);
});

test('count bar reports every panel type and connector total', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
  await expect.poll(() => page.locator('#count-bar .count-item strong').allTextContents()).toEqual(['1', '0', '0', '4']);
});

test('share URL restores recolored panel state', async ({ page }) => {
  await page.locator('.type-entry:has(.type-btn[data-type-id="plain"]) .type-color-btn').click();
  await page.locator('.palette-swatch[title="#3b82f6"]').click();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
  const url = page.url();
  const shared = new URL(url);
  expect(shared.searchParams.has('assembly')).toBe(false);
  expect(new URLSearchParams(shared.hash.slice(1)).has('assembly')).toBe(true);

  await page.goto(url);
  const state = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.world.toJSON());
  expect(state.types.find((type) => type.id === 'plain')?.color).toBe('#3b82f6');
  expect(state.panels).toHaveLength(1);
  expect(state.panels[0].typeId).toBe('plain');
});

test('table includes a centered visual-only artist chair', async ({ page }) => {
  const chair = await page.evaluate(() => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    const object = b.sceneCtx.tableGroup.getObjectByName('artist-chair');
    return object ? { position: object.position.toArray(), children: object.children.length } : null;
  });
  expect(chair).toMatchObject({ position: [36, 0, -21], children: 6 });
});

test('perpendicular placement shares a corner and serves both panel planes', async ({ page }) => {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.55, { steps: 3 });
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' }); // base panel
  await page.waitForTimeout(150);

  const target = await page.evaluate(() => {
    const b = (window as unknown as { __builder: Builder }).__builder;
    const cand = b.world.candidates().find((c) => c.plane === 'x' && c.i === 2 && c.j === 0 && c.k === 0);
    return cand ?? null;
  });
  expect(target).not.toBeNull();

  const connectors = await page.evaluate(() => [...(window as unknown as { __builder: Builder }).__builder.world.connectors.entries()]);
  expect(connectors.length).toBe(4);
});


async function clickProjected(page: Page, objectExpression: string): Promise<void> {
  const point = await page.evaluate((expression) => {
    const b = (window as unknown as { __builder: any }).__builder;
    const object = Function('b', `return ${expression}`)(b);
    const p = object.getWorldPosition(object.position.clone()).project(b.sceneCtx.camera);
    const rect = b.sceneCtx.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height };
  }, objectExpression);
  await page.mouse.click(point.x, point.y);
}
test('normal mode hovers a marker to preview the placement ghost', async ({ page }) => {
  // Normal mode: place a panel, tap it again to surface the blue marker
  // previews, then hovering a marker shows the placement ghost.
  await page.locator('.quick-mode-btn').click();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55);
  await page.waitForTimeout(200);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.55); // select → markers
  await page.waitForTimeout(200);
  const markerCount = await page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.sceneCtx.markerGroup.children.length);
  expect(markerCount).toBeGreaterThan(0);
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.68, { steps: 3 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __builder: Builder }).__builder.debug.info().ghostPlacement))
    .not.toBeNull();
});


test('normal mode places a table panel in one click', async ({ page }) => {
  await page.locator('.quick-mode-btn').click();
  await expect(page.locator('.quick-mode-btn')).toHaveText('Quick build: Off');
  await clickProjected(page, 'b.sceneCtx.tableTop');
  const state = await page.evaluate(() => {
    const b = (window as any).__builder;
    const panel = [...b.world.panels.values()][0];
    return {
      selectedKey: b.world.selectedKey,
      selectedKeyMatchesPanel: b.world.selectedKey === `${panel.plane}:${panel.i},${panel.j},${panel.k}`,
      panels: [...b.world.panels.values()],
      connectors: [...b.world.connectors.values()],
      markers: b.sceneCtx.markerGroup.children.length,
    };
  });
  expect(state.panels).toHaveLength(1);
  expect(state.panels[0].plane).toBe('y');
  expect(state.selectedKeyMatchesPanel).toBe(true);
  expect(state.markers).toBe(8);
  expect(state.connectors).toEqual(expect.arrayContaining([expect.objectContaining({ plane: 'y', sign: 1 })]));
});

test('vertical panels receive connectors at every table-contacting corner', async ({ page }) => {
  const connectors = await page.evaluate(() => {
    const b = (window as any).__builder;
    const state = b.world.toJSON();
    state.panels = [
      { plane: 'x', i: 3, j: 0, k: -1, id: 3, typeId: 'plain' },
      { plane: 'x', i: 3, j: 0, k: 0, id: 6, typeId: 'plain' },
    ];
    state.connectors = [];
    b.world.restore(state);
    return [...b.world.connectors.entries()].map(([point, connector]: [string, any]) => ({ point, ...connector }));
  });

  expect(connectors.map((connector: { point: string }) => connector.point).sort()).toEqual([
    '3,0,-1', '3,0,0', '3,0,1', '3,1,0',
  ]);
});

test('vertical connector points face centre or use table-safe fallbacks after removal', async ({ page }) => {
  const orientation = await page.evaluate(() => {
    const b = (window as any).__builder;
    const state = b.world.toJSON();
    state.panels = [
      { plane: 'x', i: 6, j: 0, k: 0, id: 28, typeId: 'plain' },
      { plane: 'x', i: 6, j: 0, k: -1, id: 29, typeId: 'plain' },
      { plane: 'x', i: 6, j: 1, k: 0, id: 30, typeId: 'plain' },
      { plane: 'x', i: 6, j: 1, k: -1, id: 31, typeId: 'plain' },
    ];
    state.connectors = [];
    b.world.restore(state);
    const before = {
      table: b.world.connectors.get('6,0,0'),
      aboveTable: b.world.connectors.get('6,1,0'),
    };
    b.world.removePanel('x:6,0,0');
    return { before, after: b.world.connectors.get('6,1,0') };
  });

  // At the table the flat plate stays down and the pointy cross-side is up.
  // Above the table, x = 6 can face the centre at x = 3 through x-sign -1;
  // removal preserves that required structural orientation.
  expect(orientation.before.table).toMatchObject({ plane: 'y', sign: 1, turn: 0 });
  expect(orientation.before.aboveTable).toMatchObject({ plane: 'x', sign: -1, turn: 0 });
  expect(orientation.after).toMatchObject({ plane: 'x', sign: -1, turn: 0 });
});

test('switching build modes deselects the active panel', async ({ page }) => {
  await page.locator('.quick-mode-btn').click();
  await clickProjected(page, 'b.sceneCtx.tableTop');
  await expect.poll(() => page.evaluate(() => (window as any).__builder.world.selectedKey)).not.toBeNull();

  await page.locator('.quick-mode-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__builder.world.selectedKey)).toBeNull();

  await page.locator('.quick-mode-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__builder.world.selectedKey)).toBeNull();
});

test('normal mode previews only edge-connected placements, never corner diagonals', async ({ page }) => {
  await page.locator('.quick-mode-btn').click();
  await clickProjected(page, 'b.sceneCtx.tableTop');
  await clickProjected(page, 'b.sceneCtx.panelGroup.children[0]');
  const before = await page.evaluate(() => {
    const b = (window as any).__builder;
    const corners = (p: any) => p.plane === 'x'
      ? [[p.i, p.j, p.k], [p.i, p.j + 1, p.k], [p.i, p.j, p.k + 1], [p.i, p.j + 1, p.k + 1]]
      : p.plane === 'y'
        ? [[p.i, p.j, p.k], [p.i + 1, p.j, p.k], [p.i, p.j, p.k + 1], [p.i + 1, p.j, p.k + 1]]
        : [[p.i, p.j, p.k], [p.i + 1, p.j, p.k], [p.i, p.j + 1, p.k], [p.i + 1, p.j + 1, p.k]];
    const key = (p: any) => `${p.plane}:${p.i},${p.j},${p.k}`;
    const candidates = [...b.world.candidates()];
    const markers = b.sceneCtx.markerGroup.children;
    const contactCounts = markers.map((marker: any) => {
      const candidate = candidates.find((placement: any) => key(placement) === marker.userData.candidateKey);
      return Math.max(...[...b.world.panels.values()].map((panel: any) =>
        corners(candidate).filter((corner: number[]) => corners(panel).some((other: number[]) => corner.join(',') === other.join(','))).length,
      ));
    });
    return {
      selected: b.world.selectedKey,
      selectionVisible: b.sceneCtx.selectionHelper.visible,
      scales: markers.map((marker: any) => marker.scale.toArray()),
      positions: Object.fromEntries(markers.map((marker: any) => [marker.userData.candidateKey, marker.position.toArray()])),
      contactCounts,
    };
  });
  await page.locator('.type-btn[data-type-id="grid"]').click();
  const after = await page.evaluate(() => Object.fromEntries(
    (window as any).__builder.sceneCtx.markerGroup.children.map((marker: any) => [marker.userData.candidateKey, marker.position.toArray()]),
  ));
  expect(before.selected).not.toBeNull();
  expect(before.selectionVisible).toBe(false);
  expect(before.scales.every((scale: number[]) => scale.every((value) => value === 0.5))).toBe(true);
  expect(before.contactCounts.every((count: number) => count === 2)).toBe(true);
  expect(after).toEqual(before.positions);
});

test('named designs restore only after explicit load confirmation', async ({ page }) => {
  await page.locator('.quick-mode-btn').click();
  await clickProjected(page, 'b.sceneCtx.tableTop');
  await page.getByRole('button', { name: 'Save design' }).click();
  await page.locator('.design-name-field input').fill('Corner');
  await page.getByRole('button', { name: 'Save design' }).last().click();
  await expect(page.locator('.action-status')).toHaveText('Saved “Corner”');

  await page.getByRole('button', { name: 'New assembly' }).click();
  await expect(page.locator('.confirmation-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(0);

  await page.getByRole('button', { name: 'Load design' }).click();
  await page.getByRole('button', { name: 'Corner' }).click();
  await expect(page.locator('.confirmation-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(1);
});
test('selecting an existing save immediately requires irreversible overwrite confirmation', async ({ page }) => {
  await page.getByRole('button', { name: 'Save design' }).click();
  await page.locator('.design-name-field input').fill('Overwrite');
  await page.getByRole('button', { name: 'Save design' }).last().click();
  await page.getByRole('button', { name: 'Save design' }).click();
  await page.getByRole('button', { name: 'Overwrite' }).click();
  const confirmation = page.locator('.confirmation-dialog');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('cannot be undone');
  await expect(page.locator('.design-dialog')).not.toBeVisible();
  await confirmation.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.action-status')).toHaveText('Saved “Overwrite”');
});

test('global material controls and share button serialize global finishes', async ({ page }) => {
  await page.locator('.material-color-btn').first().click();
  await page.locator('.palette-swatch[title="#3b82f6"]').click();
  await page.locator('.material-color-btn').nth(1).click();
  await page.locator('.palette-swatch[title="#ef4444"]').click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { document.documentElement.dataset.shareUrl = text; } },
    });
  });
  await page.getByRole('button', { name: 'Share' }).click();
  // The share handler encodes asynchronously now; the attribute lands a
  // tick after the click.
  await expect.poll(async () => await page.locator('html').getAttribute('data-share-url'), { timeout: 5_000 })
    .toMatch(/^http:\/\/[^\s]+$/);
  const share = new URL(await page.locator('html').getAttribute('data-share-url')!);
  // Packed binary link; decode with the app's codec to inspect finishes.
  const assembly = await page.evaluate((raw) => (window as any).__builder.codec.decode(raw), share.hash.slice(1).replace(/^assembly=/, ''));
  expect(assembly).toMatchObject({ metalColor: '#3b82f6', connectorColor: '#ef4444' });
});

test('HSL sliders synchronize the active plain panel color', async ({ page }) => {
  await page.locator('.type-btn[data-type-id="plain"]').locator('..').locator('.type-color-btn').click();
  await page.evaluate(() => {
    const sliders = [...document.querySelectorAll<HTMLInputElement>('.hsl-range')];
    for (const [slider, value] of [[sliders[0], '0'], [sliders[1], '80'], [sliders[2], '40']] as const) {
      slider.value = value;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const color = await page.evaluate(() => (window as any).__builder.world.types.get('plain').color);
  expect(color).toMatch(/^#[\da-f]{6}$/);
  expect(await page.locator('.hex-field input').inputValue()).toBe(color);
});

test('tutorial describes navigation, build modes, persistence, and sharing', async ({ page }) => {
  await page.getByRole('button', { name: 'Show builder tutorial' }).click();
  const tutorial = page.locator('.tutorial-dialog');
  await expect(tutorial).toBeVisible();
  await expect(tutorial).toContainText('Two fingers pan or pinch to zoom');
  await expect(tutorial).toContainText('tap the table once');
  await expect(tutorial).toContainText('Drag to build');
  await expect(tutorial).toContainText('blue possible-panel previews');
  await expect(tutorial).toContainText('even new/loaded assemblies');
});

test('new assembly requires confirmation and preserves named browser saves', async ({ page }) => {
  await page.locator('.quick-mode-btn').click();
  await clickProjected(page, 'b.sceneCtx.tableTop');
  await page.locator('button[title="Save this assembly under a name"]').click();
  await page.locator('.design-name-field input').fill('Recovery');
  await page.locator('.design-dialog').getByRole('button', { name: 'Save design' }).click();
  await page.locator('button[title="Start a fresh assembly"]').click();
  await expect(page.locator('.confirmation-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  const state = await page.evaluate(() => {
    const b = (window as any).__builder;
    return { panels: b.world.panels.size, names: JSON.parse(localStorage.getItem('artist-alley-display-builder:designs-v1')!).designs.map((design: { name: string }) => design.name) };
  });
  expect(state.panels).toBe(0);
  expect(state.names).toContain('Recovery');
});

test.describe('history and drag upgrades', () => {
  async function counts(page: Page): Promise<Record<string, number>> {
    return await page.evaluate(() => {
      const b = (window as any).__builder;
      const counts: Record<string, number> = {};
      for (const p of b.world.panels.values()) counts[p.typeId] = (counts[p.typeId] || 0) + 1;
      return counts;
    });
  }

  test('undo and redo buttons are disabled before the first change and drive history', async ({ page }) => {
    const undo = page.locator('button[title^="Undo"]');
    const redo = page.locator('button[title^="Redo"]');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await clickProjected(page, 'b.sceneCtx.tableTop');
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await undo.click();
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(0);
    await expect(redo).toBeEnabled();
    await redo.click();
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(1);
    await expect(undo).toBeEnabled();
  });

  test('keyboard Ctrl+Z undoes and Ctrl+Shift+Z redoes a placement', async ({ page }) => {
    await page.locator('.quick-mode-btn').click();
    await clickProjected(page, 'b.sceneCtx.tableTop');
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(1);
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(0);
    await page.keyboard.press('Control+Shift+z');
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(1);
  });

  test('loading a named design steps undo back to the pre-load assembly', async ({ page }) => {
    await clickProjected(page, 'b.sceneCtx.tableTop');
    await page.locator('button[title="Save this assembly under a name"]').click();
    await page.locator('.design-name-field input').fill('UndoLoad');
    await page.locator('.design-dialog').getByRole('button', { name: 'Save design' }).click();
    await page.locator('button[title="Start a fresh assembly"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(0);
    await page.locator('button[title="Load a saved named design"]').click(); // reopen the library
    await page.locator('button.saved-design', { hasText: 'UndoLoad' }).first().click();
    // selecting the entry opens the confirmation dialog; continue loads it
    await page.locator('.confirmation-dialog').getByRole('button', { name: 'Continue' }).click();
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(1);
    await page.locator('button[title^="Undo"]').click();
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(0);
  });

  test('dragging a type chip onto the table places that type', async ({ page }) => {
    const box = await canvasBox(page);
    const chip = page.locator('[data-type-id="grid"]');
    const chipBox = await chip.boundingBox();
    if (!chipBox) throw new Error('chip not found');
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.58, { steps: 5 });
    await page.mouse.up();
    expect(await counts(page)).toEqual({ grid: 1 });
  });

  test('dragging a type chip onto a placed panel retypes it', async ({ page }) => {
    await clickProjected(page, 'b.sceneCtx.tableTop');
    const box = await canvasBox(page);
    const chip = page.locator('[data-type-id="outline"]');
    const chipBox = await chip.boundingBox();
    if (!chipBox) throw new Error('chip not found');
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6, { steps: 3 });
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6);
    await page.mouse.up();
    expect(await counts(page)).toEqual({ outline: 1 });
  });

  test('a single stationary click places exactly one panel', async ({ page }) => {
    // The double-placement regression: one press-release must yield one
    // panel and one history entry, never chaining through the fresh
    // candidate markers on release.
    await clickProjected(page, 'b.sceneCtx.tableTop');
    expect(await counts(page)).toEqual({ plain: 1 });
    expect(await page.evaluate(() => (window as any).__builder.undoDepth)).toBe(1);
  });
  test('a paint stroke places a row of panels as one undo step', async ({ page }) => {
    const box = await canvasBox(page);
    // Live-swept coordinates: press on an open table square, drag right
    // through the row, release. Stroke places several panels but commits
    // as a single history entry.
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.58);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.56, box.y + box.height * 0.58, { steps: 10 });
    await page.mouse.up();
    const panels = await page.evaluate(() => (window as any).__builder.world.panels.size);
    expect(panels).toBeGreaterThan(1);
    expect(await page.evaluate(() => (window as any).__builder.undoDepth)).toBe(1);
    await page.locator('button[title^="Undo"]').click();
    expect(await page.evaluate(() => (window as any).__builder.world.panels.size)).toBe(0);
  });
});
