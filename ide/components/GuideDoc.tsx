'use client';

import { useEffect, useState } from 'react';
import { DOCS, HELP_GROUPS } from '../lib/zappDocs';
import { registerZappLanguage } from '../lib/zappLanguage';
import { IconPlus } from './icons';

// The language guide, opened as a tab next to your code. "Insert" puts an
// example into the program in the other pane.
export function GuideDoc({ canInsert, onInsert, onTour, onNewModule, onViewModule }: {
    canInsert: boolean;
    onInsert: (text: string) => void;
    onTour: () => void;
    onNewModule: () => void;
    onViewModule: (name: string) => void;
}) {
    const [filter, setFilter] = useState('');
    const query = filter.toLowerCase().trim();
    const groups = HELP_GROUPS.map(({ title, intro, keys }) => ({
        title, intro,
        docs: keys.map((k) => DOCS[k]).filter((d): d is NonNullable<typeof d> => !!d)
            .filter((d) => !query || `${d.title} ${d.summary} ${d.syntax}`.toLowerCase().includes(query)),
    })).filter((g) => g.docs.length);

    return (
        <article className="doc-page">
            <header className="doc-page-head">
                <h1>Zapp guide</h1>
                <input className="side-search" placeholder="Search the guide" value={filter}
                       onChange={(e) => setFilter(e.target.value)} aria-label="Search the guide" />
                <button className="nav-btn sm" onClick={onTour}>Take the tour</button>
            </header>
            <nav className="doc-toc" aria-label="Sections">
                {groups.map((g) => <a key={g.title} href={`#doc-${g.title}`}>{g.title}</a>)}
                {!query && <a href="#doc-make-a-module">Make your own module</a>}
            </nav>
            {groups.map(({ title, intro, docs }) => (
                <section key={title} id={`doc-${title}`} className={`doc-section ${title.startsWith('Advanced') ? 'advanced' : ''}`}>
                    <h2>{title}</h2>
                    {intro && <p className="doc-intro">{intro}</p>}
                    {docs.map((doc) => {
                        const code = doc.example ?? doc.syntax;
                        return (
                            <div key={doc.title} className="doc-entry">
                                <h3>{doc.title}</h3>
                                <p>{doc.summary}</p>
                                {doc.example && <>
                                    <span className="doc-label">How to write it</span>
                                    <ZappCode code={doc.syntax} className="doc-syntax" />
                                    <span className="doc-label">Example</span>
                                </>}
                                <div className="doc-example">
                                    <ZappCode code={code} />
                                    <button className="nav-btn sm" disabled={!canInsert} onClick={() => onInsert(code + '\n')}
                                            title={canInsert ? 'Put this into the program next to the guide' : 'Drag the Guide tab to the side of a program to insert into it'}>
                                        <IconPlus size={12} /> Insert
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </section>
            ))}
            {!query && <ModuleWalkthrough onNew={onNewModule} onView={onViewModule} />}
            {!groups.length && query && <p className="hint">Nothing in the guide matches “{filter}”.</p>}
        </article>
    );
}

// Code coloured exactly like the editor: Monaco's own colorizer with the Zapp
// language and theme. Plain text until Monaco has loaded.
function ZappCode({ code, className, language = 'zapp' }: { code: string; className?: string; language?: string }) {
    const [html, setHtml] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        import('../lib/monaco').then(({ loader }) => loader.init()).then(async (monaco) => {
            registerZappLanguage(monaco);
            monaco.editor.setTheme('zapp-dark');
            const out = await monaco.editor.colorize(code, language, { tabSize: 4 });
            if (live) setHtml(out);
        }).catch(() => undefined);
        return () => { live = false; };
    }, [code, language]);
    return html
        ? <pre className={`zapp-code ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className={`zapp-code ${className ?? ''}`}>{code}</pre>;
}

// How to make a module for a part that doesn't have one, step by step.
const STEPS: { title: string; body: string; code?: string; lang?: string }[] = [
    {
        title: 'Find the part’s datasheet',
        body: 'Search for the part’s name plus “datasheet”. You need: its I2C address, any setting it needs to start measuring, which register each reading is in, and how to turn that reading into real units.',
    },
    {
        title: 'Create the module',
        body: 'Press New module and name it after the part. Zapp opens a file with every section filled in and explained — you change the numbers.',
    },
    {
        title: 'Say what it is and where it is',
        body: 'Module files you write talk to I2C parts — most sensors are. The address is in the datasheet, usually written like 0x48.',
        code: '[module]\nname        = "tmp102"\ndescription = "TMP102 temperature sensor"\n\n[compat]\ninterface   = "i2c"\n\n[i2c]\naddr_default = 0x48', lang: 'ini',
    },
    {
        title: 'Wake it up (if it needs it)',
        body: 'Some chips sleep until told to start. The datasheet gives a register and a value; write them as register = value. The MPU6050, for example, sleeps until register 0x6B is set to 0. Leave this section out if yours starts by itself — the TMP102 does.',
        code: '# MPU6050 example\n[init]\n0x6B = 0x00', lang: 'ini',
    },
    {
        title: 'Describe each reading',
        body: 'Give each reading a name, the register it’s in, and how its bytes make a number (format). Then copy the datasheet’s maths: the TMP102 keeps temperature in the top 12 bits of two bytes, each step 0.0625 °C — so drop 4 bits and multiply.',
        code: '[fields.temp]\ntype   = "num"\nreg    = 0x00\nformat = "i16_be"\nshift  = 4\nscale  = 0.0625', lang: 'ini',
    },
    {
        title: 'Use it',
        body: 'It saves by itself and is ready straight away. If something in the file is wrong, the editor says what and where.',
        code: 'use tmp102\n\nrepeat forever:\n    get data from tmp102\n    print tmp102.temp\n    sleep 1s',
    },
];

function ModuleWalkthrough({ onNew, onView }: { onNew: () => void; onView: (name: string) => void }) {
    return (
        <section id="doc-make-a-module" className="doc-section walkthrough">
            <h2>Make your own module</h2>
            <p className="doc-intro">
                No module for your part yet? A module is a short file that tells Zapp how to read it.
                The easiest way to learn is to read one: <button className="link-btn inline" onClick={() => onView('mpu6050')}>open mpu6050</button>.
            </p>
            <ol className="steps">
                {STEPS.map((step) => (
                    <li key={step.title}>
                        <h3>{step.title}</h3>
                        <p>{step.body}</p>
                        {step.code && <ZappCode code={step.code} language={step.lang} />}
                    </li>
                ))}
            </ol>
            <p className="doc-intro">
                <b>What a module file can’t do yet:</b> parts that need their own maths (like the BMP280’s
                calibration), new kinds of screen, serial (UART) or SPI parts, and GPS sentences other than
                position and speed. Those need support built into Zapp — the modules that ship with it use that.
            </p>
            <button className="nav-btn accent" onClick={onNew}>New module</button>
        </section>
    );
}
