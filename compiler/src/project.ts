import * as fs from 'fs';
import * as path from 'path';
import { ModuleDefinition } from './emitter';
import { compileSourceToPayload } from './index';
import { parseModuleFile } from './modfile';

export interface ProjectDefinition {
    rootDir: string;
    mainSource: string;
    modules: Record<string, ModuleDefinition>;
}

export function loadProject(projectDir: string): ProjectDefinition {
    const mainPath = path.join(projectDir, 'main.zap');
    if (!fs.existsSync(mainPath)) {
        throw new Error(`Missing main.zap in ${projectDir}`);
    }

    const modulesDir = path.join(projectDir, 'modules');
    const modules: Record<string, ModuleDefinition> = {};

    if (fs.existsSync(modulesDir)) {
        for (const entry of fs.readdirSync(modulesDir)) {
            if (!entry.endsWith('.zappmod')) continue;
            const fullPath = path.join(modulesDir, entry);
            const parsed = parseModuleFile(fs.readFileSync(fullPath, 'utf8'));
            modules[parsed.name] = parsed;
        }
    }

    return {
        rootDir: projectDir,
        mainSource: fs.readFileSync(mainPath, 'utf8'),
        modules,
    };
}

export function compileProjectToPayload(projectDir: string): string {
    const project = loadProject(projectDir);
    return compileSourceToPayload(project.mainSource, project.modules);
}
