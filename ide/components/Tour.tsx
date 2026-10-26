'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

// First-visit walkthrough. Each step points at an element marked
// data-tour="<target>"; a step without a target is a centred card.

export interface TourStep { target?: string; title: string; body: string; before?: () => void }

const SEEN_KEY = 'zapp.tourSeen';

export function tourSeen(): boolean {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }   // no storage: don't nag
}

function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage unavailable */ }
}

export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
    const [index, setIndex] = useState(0);
    const [box, setBox] = useState<DOMRect | null>(null);
    const step = steps[index]!;
    const last = index === steps.length - 1;

    useEffect(() => { step.before?.(); }, [step]);

    // Follow the target, which may only appear after `before` opens a panel.
    useLayoutEffect(() => {
        const find = () => {
            const el = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
            setBox(el ? el.getBoundingClientRect() : null);
        };
        find();
        const id = requestAnimationFrame(find);
        window.addEventListener('resize', find);
        return () => { cancelAnimationFrame(id); window.removeEventListener('resize', find); };
    }, [step]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowRight' && !last) setIndex((i) => i + 1);
            else if (e.key === 'ArrowLeft' && index > 0) setIndex((i) => i - 1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [index, last, onClose]);

    const finish = () => { markSeen(); onClose(); };

    // Card beside the target: right of it if there's room, else below, else above.
    const CARD_W = 320, GAP = 14;
    let style: React.CSSProperties = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
    if (box) {
        const vw = window.innerWidth, vh = window.innerHeight;
        if (box.right + GAP + CARD_W < vw) {
            style = { left: box.right + GAP, top: Math.min(Math.max(12, box.top), vh - 220) };
        } else if (box.bottom + 200 < vh) {
            style = { left: Math.min(Math.max(12, box.left), vw - CARD_W - 12), top: box.bottom + GAP };
        } else {
            style = { left: Math.min(Math.max(12, box.left), vw - CARD_W - 12), top: Math.max(12, box.top - 200) };
        }
    }

    return (
        <div className="tour" role="dialog" aria-modal="true" aria-label="How Zapp works">
            {box
                ? <div className="tour-ring" style={{ left: box.left - 6, top: box.top - 6, width: box.width + 12, height: box.height + 12 }} />
                : <div className="tour-dim" />}
            <div className="tour-card" style={{ ...style, width: CARD_W }}>
                <span className="tour-count">{index + 1} of {steps.length}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <div className="tour-actions">
                    <button className="link-btn" onClick={onClose}>Skip</button>
                    <button className="link-btn" onClick={finish}>Don't show again</button>
                    <span className="grow" />
                    {index > 0 && <button className="nav-btn sm" onClick={() => setIndex(index - 1)}>Back</button>}
                    <button className="nav-btn accent sm" autoFocus onClick={() => (last ? finish() : setIndex(index + 1))}>
                        {last ? 'Done' : 'Next'}
                    </button>
                </div>
            </div>
        </div>
    );
}
