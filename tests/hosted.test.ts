// The hosted IDE's in-browser workspace (ide/lib/workspace.ts with no server disk).
process.env.NEXT_PUBLIC_ZAPP_HOSTED = '1';

const store: Record<string, string> = {};
(globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
};
(globalThis as any).fetch = async (url: string) => ({
    ok: true,
    json: async () => url.startsWith('/api/modules')
        ? { library: { bmp280: '[module]\nname = "bmp280"\n' }, installed: {} }
        : url.includes('path=')
            ? { path: 'examples/blink.zap', content: 'set pin LED high\n', writable: false }
            : { workspace: [], examples: [], drive: null },
});

// After the stubs above: the module reads the flag when it loads, and imports would be hoisted.
const ws: typeof import('../ide/lib/workspace') = require('../ide/lib/workspace');

const names = async () => ws.allFiles((await ws.listFiles()).workspace).map((f) => f.path);

test('starts with the starter program', async () => {
    expect(await names()).toEqual(['workspace/main.zap']);
});

test('create, copy an example, rename, move, delete', async () => {
    await ws.createFolder('workspace', 'web');
    expect((await ws.createFile('workspace', 'main')).path).toBe('workspace/main 2.zap');
    expect((await ws.copyToWorkspace('examples/blink.zap')).path).toBe('workspace/blink.zap');
    expect((await ws.readFile('workspace/blink.zap')).content).toBe('set pin LED high\n');
    await expect(ws.renameFile('workspace/blink.zap', 'blink.exe')).rejects.toThrow('usable name');
    expect((await ws.renameFile('workspace/blink.zap', 'led')).path).toBe('workspace/led.zap');
    expect((await ws.moveEntry('workspace/led.zap', 'workspace/web')).path).toBe('workspace/web/led.zap');
    await expect(ws.moveEntry('workspace/web', 'workspace/web')).rejects.toThrow("can't go inside itself");
    await ws.writeFile('workspace/web/led.zap', 'changed');
    expect((await ws.readFile('workspace/web/led.zap')).content).toBe('changed');
    await ws.deleteFile('workspace/web');
    expect(await names()).toEqual(['workspace/main 2.zap', 'workspace/main.zap']);
    await expect(ws.writeFile('examples/blink.zap', 'x')).rejects.toThrow('read-only');
});

test('modules install into the browser, hidden from the file tree', async () => {
    await ws.installModule('bmp280');
    expect(Object.keys((await ws.listModules()).installed)).toEqual(['bmp280']);
    expect(await names()).not.toContain('workspace/modules/bmp280.zappmod');
    expect(await ws.createModule('my_sensor')).toBe('workspace/modules/my_sensor.zappmod');
    await expect(ws.createModule('bmp280')).rejects.toThrow('already');
    await ws.removeModule('bmp280');
    expect(Object.keys((await ws.listModules()).installed)).toEqual(['my_sensor']);
});
