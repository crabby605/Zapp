'use client';

import type { ModuleDefinition } from '../../compiler/src/emitter';
import type { FileTree } from '../lib/workspace';
import { DOCS, HELP_GROUPS } from '../lib/zappDocs';
import { IconPencil, IconPlus, IconTrash } from './icons';

export type SidebarView = 'programs' | 'parts' | 'guide';

const pretty = (file: string) => file.replace(/\.zap$/, '').replace(/[_-]+/g, ' ');

export function Programs({ tree, activePath, dirty, onOpen, onCreate, onRename, onDelete }: {
    tree: FileTree | null;
    activePath: string | null;
    dirty: (path: string) => boolean;
    onOpen: (path: string) => void;
    onCreate: () => void;
    onRename: (path: string) => void;
    onDelete: (path: string) => void;
}) {
    if (!tree) return <p className="hint">Loading…</p>;
    const mine = tree.workspace.filter((f) => f.name.endsWith('.zap'));

    return (
        <>
            <div className="list-head">
                <h4>My programs</h4>
                <button className="icon-btn" onClick={onCreate} title="New program"><IconPlus size={14} /></button>
            </div>
            <ul className="list">
                {mine.length === 0 && <li className="hint">No programs yet — start from an example below.</li>}
                {mine.map((f) => (
                    <li key={f.path} className={activePath === f.path ? 'active' : ''}>
                        <button className="item" onClick={() => onOpen(f.path)}>
                            {pretty(f.name)}
                            {dirty(f.path) && <span className="unsaved" title="Unsaved changes" />}
                        </button>
                        <span className="item-actions">
                            <button className="icon-btn" title="Rename" onClick={() => onRename(f.path)}><IconPencil size={12} /></button>
                            <button className="icon-btn" title="Delete" onClick={() => onDelete(f.path)}><IconTrash size={12} /></button>
                        </span>
                    </li>
                ))}
            </ul>

            <div className="list-head"><h4>Examples</h4></div>
            <ul className="list">
                {tree.examples.map((f) => (
                    <li key={f.path} className={activePath === f.path ? 'active' : ''}>
                        <button className="item" onClick={() => onOpen(f.path)}>{pretty(f.name)}</button>
                    </li>
                ))}
            </ul>
        </>
    );
}

export function Parts({ modules, onInsert }: {
    modules: Record<string, ModuleDefinition>;
    onInsert: (text: string) => void;
}) {
    const list = Object.values(modules).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return <p className="hint">No parts found.</p>;
    return (
        <>
            <p className="hint">Click a part to add it to your program.</p>
            <div className="parts">
                {list.map((m) => (
                    <button key={m.name} className="part" onClick={() => onInsert(`use ${m.name}\n`)}>
                        <span className="part-head">
                            <b>{m.name}</b>
                            <span className="tag">{m.interface === 'display' ? 'screen' : m.interface}</span>
                        </span>
                        <span className="part-fields">
                            {Object.keys(m.fields).length
                                ? Object.keys(m.fields).map((f) => `${m.name}.${f}`).join('  ')
                                : `display on ${m.name} "Hello"`}
                        </span>
                    </button>
                ))}
            </div>
        </>
    );
}

export function Guide({ onInsert }: { onInsert: (text: string) => void }) {
    return (
        <>
            <p className="hint">Click an example to put it in your program.</p>
            {HELP_GROUPS.map(({ title, keys }) => (
                <section key={title} className="guide-group">
                    <h4>{title}</h4>
                    {keys.map((key) => {
                        const doc = DOCS[key];
                        if (!doc) return null;
                        return (
                            <div key={key} className="doc">
                                <b>{doc.title}</b>
                                <p>{doc.summary}</p>
                                <pre onClick={() => onInsert((doc.example ?? doc.syntax) + '\n')}>{doc.example ?? doc.syntax}</pre>
                            </div>
                        );
                    })}
                </section>
            ))}
        </>
    );
}
