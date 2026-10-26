'use client';

import type { ModuleDefinition } from '../../compiler/src/emitter';
import type { FileEntry, FileTree } from '../lib/workspace';
import { FileIcon, IconPlus, IconChevron, IconCollapse, IconCopy, IconFilePlus, IconFolder, IconFolderPlus, IconPencil, IconTarget, IconTrash } from './icons';
import type { MenuItem } from './ContextMenu';
import React, { useEffect, useRef, useState } from 'react';
import { parentOf } from '../lib/workspace';

export type SidebarView = 'programs' | 'examples' | 'modules' | 'guide';

const pretty = (file: string) => file.replace(/\.zap$/, '').replace(/[_-]+/g, ' ');

// My programs: the workspace as a JetBrains-style project tree. Folders nest;
// files can be programs or the web/ files `serve web` serves. Right-click for
// actions, arrow keys to move, type to jump, ⇧F6 / F2 renames, ⌦ deletes,
// drag onto a folder to move.

type Editing = { mode: 'file' | 'folder'; dir: string } | { mode: 'rename'; path: string } | null;

const EXPANDED_KEY = 'zapp.expanded';

function loadExpanded(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]')); } catch { return new Set(); }
}

export function FileManager({ tree, activePath, dirty, onOpen, onCreate, onRename, onDelete, onMove, onCopy, onMenu }: {
    tree: FileTree | null;
    activePath: string | null;
    dirty: (path: string) => boolean;
    onOpen: (path: string) => void;
    onCreate: (dir: string, name: string, kind: 'file' | 'folder') => Promise<boolean>;
    onRename: (path: string, name: string) => Promise<boolean>;
    onDelete: (entry: FileEntry) => void;
    onMove: (path: string, toDir: string) => void;
    onCopy: (path: string, toDir: string) => void;
    onMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
}) {
    const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
    const [editing, setEditing] = useState<Editing>(null);
    const [selectedDir, setSelectedDir] = useState('workspace');
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listRef = useRef<HTMLUListElement>(null);

    const persist = (next: Set<string>) => {
        setExpanded(next);
        try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* storage unavailable */ }
    };
    const toggle = (dir: string) => {
        const next = new Set(expanded);
        if (next.has(dir)) next.delete(dir); else next.add(dir);
        persist(next);
    };
    const expand = (dir: string) => { if (dir !== 'workspace' && dir !== 'drive' && !expanded.has(dir)) persist(new Set([...expanded, dir])); };
    const rootOf = (p: string) => p.split('/')[0];

    // Show where the open file lives.
    useEffect(() => {
        if (!activePath?.startsWith('workspace/')) return;
        const parts = activePath.split('/').slice(1, -1);
        const dirs = parts.map((_, i) => ['workspace', ...parts.slice(0, i + 1)].join('/'));
        if (dirs.some((d) => !expanded.has(d))) persist(new Set([...expanded, ...dirs]));
    }, [activePath]);   // eslint-disable-line react-hooks/exhaustive-deps

    if (!tree) return <p className="hint">Loading…</p>;

    const startNew = (mode: 'file' | 'folder', dir = selectedDir) => { expand(dir); setEditing({ mode, dir }); };

    const drop = (e: React.DragEvent, dir: string) => {
        e.preventDefault();
        setDropTarget(null);
        const from = e.dataTransfer.getData('text/x-zapp-path');
        if (!from || from === dir || parentOf(from) === dir) return;
        // Onto or off the board is a copy; within My programs it's a move.
        if (rootOf(from) !== rootOf(dir)) onCopy(from, dir); else onMove(from, dir);
        expand(dir);
    };
    const dragOver = (e: React.DragEvent, dir: string) => {
        if (!e.dataTransfer.types.includes('text/x-zapp-path')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = rootOf(dir) === 'drive' ? 'copy' : 'move';
        if (dropTarget !== dir) setDropTarget(dir);
    };

    const nameInput = (initial: string, commit: (name: string) => Promise<boolean>, depth: number, kind: 'file' | 'dir') => (
        <li className="tree-row editing" style={{ paddingLeft: 6 + depth * 14 }}>
            <span className="tree-twisty" />
            {kind === 'dir' ? <IconFolder size={14} /> : <FileIcon name={initial || 'new.zap'} size={14} />}
            <input className="tree-input" autoFocus defaultValue={initial} spellCheck={false}
                   placeholder={kind === 'dir' ? 'folder name' : 'name.zap'}
                   onFocus={(e) => {   // select the name, not the extension
                       const dot = e.target.value.lastIndexOf('.');
                       e.target.setSelectionRange(0, kind === 'file' && dot > 0 ? dot : e.target.value.length);
                   }}
                   onKeyDown={async (e) => {
                       const input = e.currentTarget;
                       if (e.key === 'Escape') { input.dataset.done = '1'; setEditing(null); }
                       if (e.key === 'Enter') {
                           const value = input.value.trim();
                           input.dataset.done = '1';   // the blur that follows mustn't commit again
                           if (!value || value === initial) return setEditing(null);
                           if (await commit(value)) setEditing(null);
                           else { input.dataset.done = ''; input.focus(); }
                       }
                   }}
                   onBlur={async (e) => {
                       const input = e.currentTarget;
                       if (input.dataset.done) return;
                       const value = input.value.trim();
                       if (value && value !== initial) await commit(value);
                       setEditing(null);
                   }} />
        </li>
    );

    const rows = (nodes: FileEntry[], dir: string, depth: number): React.ReactNode[] => {
        const out: React.ReactNode[] = [];
        if (editing && editing.mode !== 'rename' && editing.dir === dir) {
            out.push(<React.Fragment key="__new">{nameInput('',
                (name) => onCreate(dir, name, editing.mode as 'file' | 'folder'), depth, editing.mode === 'folder' ? 'dir' : 'file')}</React.Fragment>);
        }
        for (const node of nodes) {
            if (editing?.mode === 'rename' && editing.path === node.path) {
                out.push(<React.Fragment key={node.path}>{nameInput(node.name, (name) => onRename(node.path, name), depth, node.kind)}</React.Fragment>);
                if (node.kind === 'dir' && expanded.has(node.path)) out.push(...rows(node.children ?? [], node.path, depth + 1));
                continue;
            }
            const isDir = node.kind === 'dir';
            const open = isDir && expanded.has(node.path);
            const onBoard = rootOf(node.path) === 'drive';
            const canChange = changeable(node);
            out.push(
                <li key={node.path} role="treeitem" aria-expanded={isDir ? open : undefined}
                    className={`tree-row ${activePath === node.path ? 'active' : ''} ${isDir && selectedDir === node.path ? 'selected' : ''} ${dropTarget === node.path ? 'drop' : ''}`}
                    style={{ paddingLeft: 6 + depth * 14 }}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/x-zapp-path', node.path); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDropTarget(null)}
                    onDragOver={isDir ? (e) => dragOver(e, node.path) : undefined}
                    onDragLeave={isDir ? () => setDropTarget(null) : undefined}
                    onDrop={isDir ? (e) => drop(e, node.path) : undefined}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(e, rowMenu(node)); }}>
                    <button className="tree-item" data-path={node.path}
                            onClick={() => { if (isDir) { toggle(node.path); setSelectedDir(node.path); } else { onOpen(node.path); setSelectedDir(parentOf(node.path)); } }}
                            onKeyDown={(e) => {
                                if (canChange && (e.key === 'F2' || (e.key === 'F6' && e.shiftKey))) { e.preventDefault(); setEditing({ mode: 'rename', path: node.path }); }
                                if (canChange && (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey))) { e.preventDefault(); onDelete(node); }
                                if (e.key === 'ArrowRight' && isDir) { e.preventDefault(); if (!open) toggle(node.path); else moveFocus(1); }
                                if (e.key === 'ArrowLeft') {
                                    e.preventDefault();
                                    if (isDir && open) toggle(node.path);
                                    else listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(parentOf(node.path))}"]`)?.focus();
                                }
                            }}>
                        <span className={`tree-twisty ${open ? 'open' : ''}`}>{isDir && <IconChevron size={12} />}</span>
                        {isDir ? <IconFolder size={14} /> : <FileIcon name={node.name} size={14} />}
                        <span className="tree-name">{node.name}</span>
                        {!isDir && dirty(node.path) && <span className="unsaved" title="Unsaved changes" />}
                    </button>
                    <span className="item-actions">
                        {isDir && <button className="icon-btn" title="New file here" onClick={() => startNew('file', node.path)}><IconFilePlus size={12} /></button>}
                        {isDir && !onBoard && <button className="icon-btn" title="New folder here" onClick={() => startNew('folder', node.path)}><IconFolderPlus size={12} /></button>}
                        {canChange && <button className="icon-btn" title="Rename (F2)" onClick={() => setEditing({ mode: 'rename', path: node.path })}><IconPencil size={12} /></button>}
                        {canChange && <button className="icon-btn" title="Delete" onClick={() => onDelete(node)}><IconTrash size={12} /></button>}
                    </span>
                </li>,
            );
            if (open) out.push(...rows(node.children ?? [], node.path, depth + 1));
        }
        return out;
    };

    const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
    // On the board only files in modules/ and web/ can be renamed or deleted.
    const changeable = (node: FileEntry) => rootOf(node.path) !== 'drive'
        || (node.kind === 'file' && node.writable !== false && node.path.split('/').length === 3);
    const rowMenu = (node: FileEntry): MenuItem[] => {
        const rel = node.path.replace(/^(workspace|drive)\//, '');
        const onBoard = rootOf(node.path) === 'drive';
        const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
        const drive = tree.drive;
        const copyItems: MenuItem[] = node.kind !== 'file' ? []
            : onBoard ? [{ label: 'Copy to My programs', run: () => onCopy(node.path, 'workspace') }]
            : !drive ? []
            : ext === 'zap' ? [{ label: 'Put on board as main.zap', run: () => onCopy(node.path, 'drive') }]
            : ext === 'zappmod' ? [{ label: 'Copy to board’s modules/', run: () => onCopy(node.path, 'drive/modules') }]
            : ['html', 'htm', 'css', 'js', 'json', 'svg', 'txt'].includes(ext)
                ? [{ label: 'Copy to board’s web/', disabled: !drive.hasWeb, run: () => onCopy(node.path, 'drive/web') }]
                : [];
        return [
            ...(node.kind === 'file' ? [{ label: 'Open', keys: '⏎', run: () => onOpen(node.path) }] : []),
            ...(node.kind === 'dir' ? [
                { label: 'New file', run: () => startNew('file', node.path) },
                ...(onBoard ? [] : [{ label: 'New folder', run: () => startNew('folder', node.path) }]),
            ] : []),
            ...(copyItems.length ? ['sep' as const, ...copyItems] : []),
            'sep',
            { label: 'Rename…', keys: '⇧F6', disabled: !changeable(node), run: () => setEditing({ mode: 'rename', path: node.path }) },
            { label: 'Delete', keys: '⌦', danger: true, disabled: !changeable(node), run: () => onDelete(node) },
            'sep',
            { label: 'Copy name', run: () => copy(node.name) },
            { label: 'Copy path', run: () => copy(rel) },
        ];
    };
    const backgroundMenu: MenuItem[] = [
        { label: 'New file', run: () => startNew('file', 'workspace') },
        { label: 'New folder', run: () => startNew('folder', 'workspace') },
        'sep',
        { label: 'Collapse all', run: () => persist(new Set()) },
    ];

    // Arrow keys move between visible rows; typing jumps to a matching name.
    const rowsInOrder = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('.tree-item') ?? []);
    const moveFocus = (by: number) => {
        const items = rowsInOrder();
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + by))]?.focus();
    };
    const onTreeKey = (e: React.KeyboardEvent) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); return; }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
            const next = (search + e.key).toLowerCase();
            setSearch(next);
            if (searchTimer.current) clearTimeout(searchTimer.current);
            searchTimer.current = setTimeout(() => setSearch(''), 1200);
            const hit = rowsInOrder().find((el) => el.querySelector('.tree-name')?.textContent?.toLowerCase().includes(next));
            hit?.focus();
        } else if (e.key === 'Escape') setSearch('');
    };

    // Scroll to the open file, like JetBrains' "Select Opened File".
    const revealActive = () => {
        if (!activePath) return;
        const el = listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activePath)}"]`);
        el?.scrollIntoView({ block: 'nearest' });
        el?.focus();
    };

    const where = selectedDir === 'workspace' ? 'the top level' : selectedDir.replace(/^workspace\//, '');
    return (
        <>
            <div className="list-head">
                <h4>Workspace</h4>
                <span className="tree-tools">
                    <button className="icon-btn" onClick={() => startNew('file')} title={`New file in ${where}`}><IconFilePlus size={14} /></button>
                    <button className="icon-btn" onClick={() => startNew('folder')} title={`New folder in ${where}`}><IconFolderPlus size={14} /></button>
                    <button className="icon-btn" onClick={revealActive} title="Select opened file" disabled={!activePath?.startsWith('workspace/')}><IconTarget size={14} /></button>
                    <button className="icon-btn" onClick={() => persist(new Set())} title="Collapse all"><IconCollapse size={14} /></button>
                </span>
            </div>
            {search && <div className="tree-search" aria-live="polite">{search}</div>}
            <ul ref={listRef} role="tree" className={`tree ${dropTarget === 'workspace' ? 'drop' : ''}`}
                onKeyDown={onTreeKey}
                onContextMenu={(e) => { e.preventDefault(); onMenu(e, backgroundMenu); }}
                onDragOver={(e) => dragOver(e, 'workspace')}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null); }}
                onDrop={(e) => { if (dropTarget === 'workspace') drop(e, 'workspace'); }}
                onClick={(e) => { if (e.currentTarget === e.target) setSelectedDir('workspace'); }}>
                {rows(tree.workspace, 'workspace', 0)}
                {tree.workspace.length === 0 && !editing && <li className="hint">No files yet.</li>}
            </ul>
            {tree.drive && (
                <>
                    <div className="list-head drive-head">
                        <h4 title={`Mounted as ${tree.drive.name}`}>Zapp Drive</h4>
                        <span className="drive-slots" title="Space for the files in modules/ and web/">
                            {tree.drive.bytes !== null
                                ? `${(tree.drive.bytesUsed / 1024).toFixed(1)} of ${Math.floor(tree.drive.bytes / 1024)}KB`
                                : `${tree.drive.slotsUsed} of ${tree.drive.slots} files`}
                        </span>
                    </div>
                    <ul role="tree" className={`tree drive ${dropTarget === 'drive' ? 'drop' : ''}`}
                        onKeyDown={onTreeKey}
                        onDragOver={(e) => dragOver(e, 'drive')}
                        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null); }}
                        onDrop={(e) => { if (dropTarget === 'drive') drop(e, 'drive'); }}>
                        {rows(tree.drive.tree, 'drive', 0)}
                    </ul>
                    {!tree.drive.hasWeb && <p className="hint">This board has older Zapp without a web/ folder. Install the latest Zapp to put web pages on it.</p>}
                </>
            )}
        </>
    );
}

// Read-only examples, kept apart from your own programs. Opening one shows it;
// the copy button puts an editable copy in My programs.
export function Examples({ examples, activePath, notes, onOpen, onCopy }: {
    examples: FileEntry[];
    activePath: string | null;
    /** Example path → why it won't run on the picked board. */
    notes: Record<string, string>;
    onOpen: (path: string) => void;
    onCopy: (path: string) => void;
}) {
    const [filter, setFilter] = useState('');
    const shown = examples.filter((f) => pretty(f.name).includes(filter.toLowerCase().trim()));
    return (
        <>
            <input className="side-search" placeholder="Filter examples" value={filter}
                   onChange={(e) => setFilter(e.target.value)} aria-label="Filter examples" />
            <ul className="list">
                {shown.map((f) => (
                    <li key={f.path} className={[activePath === f.path ? 'active' : '', notes[f.path] ? 'unfit' : ''].join(' ')}>
                        <button className="item" onClick={() => onOpen(f.path)} title={notes[f.path]}>
                            {pretty(f.name)}
                            {notes[f.path] && <span className="item-note">{notes[f.path]}</span>}
                        </button>
                        <span className="item-actions">
                            <button className="icon-btn" title="Copy to My programs" onClick={() => onCopy(f.path)}><IconCopy size={12} /></button>
                        </span>
                    </li>
                ))}
                {shown.length === 0 && <li className="hint">No example matches “{filter}”.</li>}
            </ul>
        </>
    );
}

// Module manager, like Arduino's Library Manager: everything in the library,
// with Install / Update / Remove. Installing also adds `use <name>` to the open
// program.
export function ModuleManager({ library, installed, busy, onInstall, onRemove, onUse, onView, onNew }: {
    library: Record<string, ModuleDefinition>;
    installed: Record<string, ModuleDefinition>;
    busy: string | null;
    onInstall: (name: string) => void;
    onRemove: (name: string) => void;
    onUse: (name: string) => void;
    onView: (name: string) => void;
    onNew: () => void;
}) {
    const [filter, setFilter] = useState('');
    const [only, setOnly] = useState<'all' | 'installed'>('all');
    const query = filter.toLowerCase().trim();
    const list = Object.values({ ...library, ...installed })
        .filter((m) => only === 'all' || installed[m.name])
        .filter((m) => !query || `${m.name} ${m.description ?? ''} ${m.interface}`.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name));

    return (
        <>
            <button className="nav-btn sm new-module" onClick={onNew}><IconPlus size={12} /> New module</button>
            <input className="side-search" placeholder="Search modules (bmp280, oled, gps…)" value={filter}
                   onChange={(e) => setFilter(e.target.value)} aria-label="Search modules" />
            <div className="seg" role="tablist">
                {(['all', 'installed'] as const).map((k) => (
                    <button key={k} role="tab" aria-selected={only === k} className={only === k ? 'on' : ''} onClick={() => setOnly(k)}>
                        {k === 'all' ? 'All' : `Installed (${Object.keys(installed).length})`}
                    </button>
                ))}
            </div>
            <div className="parts">
                {list.map((m) => {
                    const mine = installed[m.name];
                    const latest = library[m.name];
                    const update = mine && latest && latest.version && latest.version !== mine.version;
                    const working = busy === m.name;
                    return (
                        <div key={m.name} className={`part module ${mine ? 'installed' : ''}`}>
                            <span className="part-head">
                                <b>{m.name}</b>
                                <span className="tag">{m.interface === 'display' ? 'screen' : m.interface}</span>
                            </span>
                            {m.description && <span className="part-desc">{m.description}</span>}
                            <span className="part-fields">
                                {mine ? `v${mine.version ?? '?'} installed` : `v${m.version ?? '?'}`}
                                {m.author ? ` · ${m.author}` : ''}
                            </span>
                            <span className="part-actions">
                                {!mine && <button className="nav-btn accent sm" disabled={working} onClick={() => onInstall(m.name)}>{working ? 'Installing…' : 'Install'}</button>}
                                {update && <button className="nav-btn accent sm" disabled={working} onClick={() => onInstall(m.name)}>Update to v{latest.version}</button>}
                                {mine && <button className="nav-btn sm" onClick={() => onUse(m.name)}>Use in program</button>}
                                <button className="nav-btn ghost sm" onClick={() => onView(m.name)} title="Open the module file to see how it works">View</button>
                                {mine && <button className="nav-btn ghost sm" disabled={working} onClick={() => onRemove(m.name)}>Remove</button>}
                            </span>
                        </div>
                    );
                })}
                {list.length === 0 && <p className="hint">{only === 'installed' && !query ? 'Nothing installed yet.' : 'No module matches.'}</p>}
            </div>
        </>
    );
}
