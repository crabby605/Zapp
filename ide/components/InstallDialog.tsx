'use client';

import { useState } from 'react';
import type { BoardDefinition } from '../../compiler/src/index';
import { firmwareUrl, firmwareVariant, installViaServer } from '../lib/install';
import { HOSTED } from '../lib/workspace';
import { IconCheck, IconClose, IconDownload } from './icons';

type Step = 'ready' | 'waiting' | 'done' | 'error';

export function InstallDialog({ boards, board, onBoard, canAutoBoot, onAutoBoot, onClose }: {
    boards: BoardDefinition[];
    board: BoardDefinition | undefined;
    onBoard: (name: string) => void;
    /** A board running Zapp is connected and can restart itself into install mode. */
    canAutoBoot: boolean;
    onAutoBoot: () => Promise<void>;
    onClose: () => void;
}) {
    const [step, setStep] = useState<Step>('ready');
    const [error, setError] = useState('');
    const variant = firmwareVariant(board?.name ?? 'pico');
    const howTo = board?.install ?? 'Hold the BOOT button while you plug the board in';
    // Only RP2040 boards take a .uf2; ESP32-S3 boards flash with idf.py. Hosted,
    // the server can't see the board, so you drag the file on yourself.
    const chip = board?.chip ?? 'rp2040';
    const canAuto = chip === 'rp2040' && !HOSTED;

    const install = async () => {
        setStep('waiting');
        setError('');
        try {
            if (canAutoBoot) await onAutoBoot();
            await installViaServer(variant);
            if (board) onBoard(board.name);   // so the board is told what it is on next connect
            setStep('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Install failed');
            setStep('error');
        }
    };

    return (
        <div className="scrim" onMouseDown={() => step !== 'waiting' && onClose()}>
            <div className="dialog" role="dialog" aria-label="Install Zapp" onMouseDown={(e) => e.stopPropagation()}>
                <header>
                    <h2>Install Zapp on your board</h2>
                    <button className="icon-btn" onClick={onClose} disabled={step === 'waiting'} aria-label="Close"><IconClose size={14} /></button>
                </header>

                {step === 'done' ? (
                    <div className="done">
                        <span className="done-mark"><IconCheck size={22} /></span>
                        <p><b>Zapp is installed.</b> The board restarts by itself and a drive called
                            <code>Zapp Drive</code> appears. Press <b>Connect board</b> to start.</p>
                        <button className="btn primary" onClick={onClose}>Done</button>
                    </div>
                ) : (
                    <>
                        <label className="field">
                            <span>Board</span>
                            <select value={board?.name} disabled={step === 'waiting'} onChange={(e) => onBoard(e.target.value)}>
                                {boards.map((b) => <option key={b.name} value={b.name}>{b.title}</option>)}
                            </select>
                        </label>

                        {step === 'waiting' ? (
                            <div className="waiting">
                                <span className="spinner" />
                                <div>
                                    <b>{canAutoBoot ? 'Restarting your board into install mode…' : 'Waiting for your board…'}</b>
                                    {!canAutoBoot && <p>{howTo}. A drive called <code>RPI-RP2</code> appears and Zapp installs by itself.</p>}
                                </div>
                            </div>
                        ) : chip === 'esp32s3' ? (
                            <p className="lead">ESP32-S3 boards install from the command line: <b>{howTo}</b>. The
                                steps are in <a className="link" href="https://github.com/crabby605/Zapp/blob/main/docs/building.md" target="_blank" rel="noreferrer">docs/building.md</a>.</p>
                        ) : chip !== 'rp2040' ? (
                            <p className="lead">Zapp doesn't have firmware for this board yet.</p>
                        ) : canAuto ? (
                            <>
                                <p className="lead">
                                    {canAutoBoot
                                        ? 'Your board already runs Zapp, so it can restart itself into install mode.'
                                        : <>Press <b>Install</b>, then put the board in install mode: <b>{howTo}</b>.</>}
                                </p>
                                <button className="btn primary big" onClick={install}>Install Zapp</button>
                            </>
                        ) : (
                            <>
                                <p className="lead">Download Zapp, then put the board in install mode: <b>{howTo}</b>.
                                    A drive called <code>RPI-RP2</code> appears — drag <code>zapp.uf2</code> onto it.</p>
                                <a className="btn primary big" href={firmwareUrl(variant)} download={`zapp-${variant}.uf2`}>
                                    <IconDownload size={14} /> Download zapp.uf2
                                </a>
                            </>
                        )}

                        {error && <p className="error-text">{error}</p>}
                        {canAuto && step !== 'waiting' && (
                            <a className="link" href={firmwareUrl(variant)} download>
                                <IconDownload size={13} /> Or download zapp.uf2 and drag it onto RPI-RP2 yourself
                            </a>
                        )}
                        <p className="fineprint">
                            Installing replaces whatever firmware the board runs now (CircuitPython, MicroPython…)
                            and erases its drive — copy off anything you want to keep first.
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
