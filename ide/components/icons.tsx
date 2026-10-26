// One small icon set, drawn on a 16px grid at 1.5px stroke.
type Props = { size?: number };

const svg = (path: React.ReactNode, size = 16) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true">
        {path}
    </svg>
);

export const IconFiles = ({ size }: Props) => svg(
    <><path d="M2.5 3.5h4l1.2 1.5h5.8v7.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" /></>, size);

export const IconChip = ({ size }: Props) => svg(
    <><rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14" /></>, size);

export const IconBoard = ({ size }: Props) => svg(
    <><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <circle cx="5.5" cy="8" r="1" /><path d="M8 6.5h3.5M8 9.5h3.5" /></>, size);

export const IconHelp = ({ size }: Props) => svg(
    <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" />
      <circle cx="8" cy="11.6" r="0.6" fill="currentColor" stroke="none" /></>, size);

export const IconPlay = ({ size }: Props) => svg(
    <><path d="M5 3.2 12.5 8 5 12.8z" fill="currentColor" stroke="none" /></>, size);

export const IconStop = ({ size }: Props) => svg(
    <><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" /></>, size);

export const IconUpload = ({ size }: Props) => svg(
    <><path d="M8 11V3.5M5 6.2 8 3.2l3 3M3 12.5h10" /></>, size);

export const IconPlug = ({ size }: Props) => svg(
    <><path d="M6 2v3.5M10 2v3.5M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0zM8 11v3" /></>, size);

export const IconRefresh = ({ size }: Props) => svg(
    <><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5H10" /></>, size);

export const IconClose = ({ size }: Props) => svg(<><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></>, size);
export const IconPlus = ({ size }: Props) => svg(<><path d="M8 3.5v9M3.5 8h9" /></>, size);
export const IconTrash = ({ size }: Props) => svg(
    <><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" /></>, size);
export const IconCopy = ({ size }: Props) => svg(
    <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 3.5h-8v8" /></>, size);
export const IconSearch = ({ size }: Props) => svg(
    <><circle cx="7.2" cy="7.2" r="4" /><path d="M10.3 10.3 14 14" /></>, size);
export const IconBolt = ({ size }: Props) => svg(
    <><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor" stroke="none" /></>, size);
export const IconChevron = ({ size }: Props) => svg(<><path d="M4.5 6.5 8 10l3.5-3.5" /></>, size);
export const IconMore = ({ size }: Props) => svg(
    <><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" /></>, size);
export const IconDownload = ({ size }: Props) => svg(<><path d="M8 3v7.5M5 7.8 8 10.8l3-3M3 13h10" /></>, size);
export const IconSave = ({ size }: Props) => svg(
    <><path d="M3 3.5a1 1 0 0 1 1-1h6.5L13 5v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M5.5 2.5v3h4v-3M5.5 13.5v-4h5v4" /></>, size);
export const IconSim = ({ size }: Props) => svg(
    <><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M5.5 14h5M8 11v3" /></>, size);
export const IconWarn = ({ size }: Props) => svg(
    <><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3" /><circle cx="8" cy="11.2" r="0.6" fill="currentColor" stroke="none" /></>, size);
export const IconCheck = ({ size }: Props) => svg(<><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></>, size);
export const IconPencil = ({ size }: Props) => svg(<><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /></>, size);
export const IconBook = ({ size }: Props) => svg(
    <><path d="M2.5 3.5c2-.8 3.8-.8 5.5.5 1.7-1.3 3.5-1.3 5.5-.5v9c-2-.8-3.8-.8-5.5.5-1.7-1.3-3.5-1.3-5.5-.5z" /><path d="M8 4v9" /></>, size);
export const IconPackage = ({ size }: Props) => svg(
    <><path d="M8 2 13.5 5v6L8 14 2.5 11V5z" /><path d="M2.5 5 8 8l5.5-3M8 8v6" /></>, size);
export const IconFolder = ({ size }: Props) => svg(
    <><path d="M2 4.5a1 1 0 0 1 1-1h3.3l1.4 1.6H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></>, size);
export const IconFolderPlus = ({ size }: Props) => svg(
    <><path d="M2 4.5a1 1 0 0 1 1-1h3.3l1.4 1.6H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M8 7.5v4M6 9.5h4" /></>, size);
export const IconFile = ({ size }: Props) => svg(
    <><path d="M4 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5z" /><path d="M9 2v3h3" /></>, size);
export const IconFilePlus = ({ size }: Props) => svg(
    <><path d="M4 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5z" /><path d="M9 2v3h3M8 7.5v4M6 9.5h4" /></>, size);
export const IconCollapse = ({ size }: Props) => svg(<><path d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5" /></>, size);
export const IconTarget = ({ size }: Props) => svg(
    <><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.6" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" /></>, size);

// File icon by type, coloured the way JetBrains does: programs, web files, data, notes.
const FILE_KINDS: Record<string, { cls: string; label: string }> = {
    zap: { cls: 'fi-zap', label: 'Z' }, html: { cls: 'fi-html', label: '<>' }, htm: { cls: 'fi-html', label: '<>' },
    css: { cls: 'fi-css', label: '#' }, js: { cls: 'fi-js', label: 'JS' }, json: { cls: 'fi-json', label: '{}' },
    svg: { cls: 'fi-svg', label: '◇' }, md: { cls: 'fi-md', label: 'M' }, txt: { cls: 'fi-txt', label: '≡' },
    csv: { cls: 'fi-txt', label: ',' }, zappmod: { cls: 'fi-json', label: 'm' },
};

export const FileIcon = ({ name, size = 14 }: { name: string; size?: number }) => {
    const kind = FILE_KINDS[name.split('.').pop()?.toLowerCase() ?? ''] ?? { cls: 'fi-txt', label: '' };
    return <span className={`file-icon ${kind.cls}`} style={{ width: size, height: size, fontSize: size * 0.52 }} aria-hidden="true">{kind.label}</span>;
};
export const IconError = ({ size }: Props) => svg(
    <><circle cx="8" cy="8" r="6" /><path d="M6 6l4 4M10 6l-4 4" /></>, size);
export const IconSplit = ({ size }: Props) => svg(
    <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M8 3v10" /></>, size);
