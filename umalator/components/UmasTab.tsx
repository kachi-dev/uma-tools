import { h, Fragment } from 'preact';
import { useState, useEffect, useCallback, useMemo, useContext } from 'preact/hooks';
import { Text, IntlContext } from 'preact-i18n';

import { decodeRoster, saveRoster, loadRoster, DecodedUma } from '../rosterDecoder';
import './UmasTab.css';

import umas from '../../umas.json';
import icons from '../../icons.json';
import skillmeta from '../../skill_meta.json';
import skilldata from '../../uma-skill-tools/data/skill_data.json';
import { isPurpleSkill } from '../BasinnChart';
const STORAGE_KEY = 'umas_tab_roster';

const APT_LETTERS = ['?', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'S', '★'];
const APT_GRADE_OPTIONS = ['—', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'S'];

// rarity 1=white, 2=gold, 3-5=unique, 6=pink
const RARITY_CLASS: Record<number, string> = { 1: 'umasRarity-white', 2: 'umasRarity-gold', 3: 'umasRarity-unique', 4: 'umasRarity-unique', 5: 'umasRarity-unique', 6: 'umasRarity-pink' };

// ── Types ────────────────────────────────────────────────────────────────────

type AptKey = 'apt_turf' | 'apt_dirt' | 'apt_short' | 'apt_mile' |
              'apt_middle' | 'apt_long' | 'apt_nige' | 'apt_senko' |
              'apt_sashi' | 'apt_oikomi';

interface FilterState {
    name: string;
    aptMin: Partial<Record<AptKey, number>>;
    skills: number[];
}

const EMPTY_FILTERS: FilterState = { name: '', aptMin: {}, skills: [] };

// ── Helpers ──────────────────────────────────────────────────────────────────

function aptIconIdx(v: number): number {
    return Math.max(0, Math.min(7, v - 1));
}

function rankForStat(x: number): number {
    if (x > 1200) {
        return Math.min(18 + Math.floor((x - 1200) / 100) * 10 + Math.floor(x / 10) % 10, 97);
    } else if (x >= 1150) {
        return 17;
    } else if (x >= 1100) {
        return 16;
    } else if (x >= 400) {
        return 8 + Math.floor((x - 400) / 100);
    } else {
        return Math.floor(x / 50);
    }
}

function statRankStr(v: number): string {
    return String(100 + rankForStat(v)).slice(1);
}

function getCharInfo(card_id: number) {
    const charId = String(Math.floor(card_id / 100));
    const outfitId = String(card_id);
    const character = (umas as any)[charId];
    const charName = character?.name?.[1] ?? `Unknown (${charId})`;
    const outfitName = character?.outfits?.[outfitId] ?? '';
    const iconSrc = (icons as any)[outfitId] ?? (icons as any)[charId] ?? '/uma-tools/icons/utx_ico_umamusume_00.png';
    return { charName, outfitName, iconSrc };
}


export const skillGroups = Object.keys(skilldata)
    .filter((id) => (skillmeta as Record<string, unknown>)[id])
    .sort((a, b) =>
        (isPurpleSkill(a) ? 1 : 0) - (isPurpleSkill(b) ? 1 : 0) ||
        (skilldata as Record<string, { rarity: number }>)[a].rarity - (skilldata as Record<string, { rarity: number }>)[b].rarity ||
        +b - +a
    )
    .reduce((groups, id) => {
        const groupId = (skillmeta as Record<string, { groupId: string }>)[id].groupId;
        if (groups.has(groupId)) {
            groups.get(groupId)!.push(id);
        } else {
            groups.set(groupId, [id]);
        }
        return groups;
    }, new Map<string, string[]>());

function costForId(id: number, owned: Map<string, number>): number {
    const meta = skillmeta as Record<string, { groupId: string; baseCost: number }>;
    const idStr = String(id);
    const m = meta[idStr];
    if (!m) return 0;
    const group = skillGroups.get(m.groupId);
    if (!group) return meta[idStr]?.baseCost ?? 0;
    const existing = owned.get(m.groupId);
    let cost = 0;
    for (let i = 0; i < group.length; ++i) {
        if (Number(group[i]) !== existing) {
            cost += (meta[group[i]]?.baseCost ?? 0);
        }
        if (group[i] === idStr) break;
    }
    return cost;
}

function skillOrder(a: string, b: string): number {
    const x = (skillmeta as any)[a]?.order ?? 0;
    const y = (skillmeta as any)[b]?.order ?? 0;
    return +(y < x) - +(x < y) || +(b < a) - +(a < b);
}

function calcTotalSP(skills: Array<{ id: number; level: number }>): number {
    const data = skilldata as Record<string, { rarity: number }>;
    const meta = skillmeta as Record<string, { groupId: string }>;
    const countsTowardSP = (idStr: string) => {
        const r = data[idStr]?.rarity ?? 1;
        return r < 3 || r > 5;
    };

    const highestIndexByGroup = new Map<string, number>();
    for (const s of skills) {
        const idStr = String(s.id);
        if (!countsTowardSP(idStr)) continue;
        const groupId = meta[idStr]?.groupId;
        if (!groupId) continue;
        const group = skillGroups.get(groupId);
        const idx = group?.indexOf(idStr) ?? -1;
        if (idx < 0) continue;
        const best = highestIndexByGroup.get(groupId) ?? -1;
        if (idx > best) highestIndexByGroup.set(groupId, idx);
    }

    let total = 0;
    for (const [groupId, idx] of highestIndexByGroup) {
        const skillId = Number(skillGroups.get(groupId)![idx]);
        total += costForId(skillId, new Map());
    }
    return total;
}

type SortKey = 'sp' | 'time' | 'rating';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey; dir: SortDir; }
const SORT_LABELS: Record<SortKey, string> = { sp: 'Total SP', time: 'Created', rating: 'Rating' };
const DEFAULT_SORT: SortState = { key: 'time', dir: 'desc' };

// ── Filter logic ─────────────────────────────────────────────────────────────

function panelFilterCount(f: FilterState): number {
    const aptActive = Object.values(f.aptMin).filter(v => (v ?? 0) > 0).length;
    return aptActive + f.skills.length;
}

function isFilterActive(f: FilterState): boolean {
    return !!f.name || panelFilterCount(f) > 0;
}

function filterUmas(allUmas: DecodedUma[], f: FilterState): DecodedUma[] {
    if (!isFilterActive(f)) return allUmas;
    return allUmas.filter(uma => {
        if (f.name) {
            const { charName, outfitName } = getCharInfo(uma.card_id);
            const q = f.name.toLowerCase();
            if (!charName.toLowerCase().includes(q) && !outfitName.toLowerCase().includes(q)) return false;
        }
        for (const [key, min] of Object.entries(f.aptMin)) {
            if ((min ?? 0) > 0 && (uma as any)[key] < min!) return false;
        }
        for (const skillId of f.skills) {
            if (!uma.skills.some(s => s.id === skillId)) return false;
        }
        return true;
    });
}

function buildSkillIndex(allUmas: DecodedUma[], intlSkillNames: Record<string, string>): Map<number, string> {
    const seen = new Map<number, string>();
    for (const uma of allUmas) {
        for (const s of uma.skills) {
            if (!seen.has(s.id)) {
                const idStr = String(s.id);
                if ((skillmeta as any)[idStr] && (skilldata as any)[idStr]) {
                    const name = intlSkillNames[idStr] ?? String(s.id);
                    seen.set(s.id, name);
                }
            }
        }
    }
    return seen;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function AptCell({ label, value }: { label: string; value: number }) {
    const idx = aptIconIdx(value);
    const letter = APT_LETTERS[Math.max(0, Math.min(9, value))] ?? '?';
    return (
        <div class="umasAptCell" title={`${label}: ${letter}`}>
            <span class="umasAptCellLabel">{label}</span>
            {value > 0
                ? <img class="umasAptIcon" src={`/uma-tools/icons/utx_ico_statusrank_${String(100 + idx).slice(1)}.png`} alt={letter} />
                : <span class="umasAptEmpty">—</span>
            }
        </div>
    );
}

function AptFilterSelect({ aptKey, label, value, onChange }: {
    aptKey: AptKey;
    label: string;
    value: number;
    onChange: (key: AptKey, val: number) => void;
}) {
    return (
        <label class="umasAptFilterCell">
            <span class="umasAptCellLabel">{label}</span>
            <select
                class="umasAptSelect"
                value={value}
                onChange={(e) => onChange(aptKey, +(e.target as HTMLSelectElement).value)}
            >
                {APT_GRADE_OPTIONS.map((g, i) => (
                    <option key={i} value={i}>{g}</option>
                ))}
            </select>
        </label>
    );
}

function SkillPicker({ selected, onChange, availableSkills }: {
    selected: number[];
    onChange: (ids: number[]) => void;
    availableSkills: Map<number, string>;
}) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);

    const q = query.toLowerCase();
    const matches = q.length >= 1
        ? Array.from(availableSkills.entries())
            .filter(([id, name]) => !selected.includes(id) && name.toLowerCase().includes(q))
            .sort((a, b) => {
                const ra = (skilldata as any)[String(a[0])]?.rarity ?? 1;
                const rb = (skilldata as any)[String(b[0])]?.rarity ?? 1;
                return rb - ra;
            })
            .slice(0, 12)
        : [];

    function add(id: number) {
        onChange([...selected, id]);
        setQuery('');
        setOpen(false);
    }

    function remove(id: number) {
        onChange(selected.filter(s => s !== id));
    }

    return (
        <div class="umasSkillPicker">
            <div class="umasSkillPickerChips">
                {selected.map(id => {
                    const name = availableSkills.get(id) ?? String(id);
                    const idStr = String(id);
                    const iconId = (skillmeta as any)[idStr]?.iconId;
                    const rarity: number = (skilldata as any)[idStr]?.rarity ?? 1;
                    const rarityClass = RARITY_CLASS[rarity] ?? 'umasRarity-white';
                    return (
                        <span key={id} class={`umasSkillChip ${rarityClass}`}>
                            {iconId && <img src={`/uma-tools/icons/${iconId}.png`} class="umasSkillChipIcon" />}
                            <span class="umasSkillChipName">{name}</span>
                            <button class="umasSkillChipRemove" onClick={() => remove(id)} type="button">×</button>
                        </span>
                    );
                })}
                <div class="umasSkillSearchWrap">
                    <input
                        type="text"
                        class="umasSkillSearch"
                        placeholder={selected.length === 0 ? 'Search for a required skill…' : 'Add another…'}
                        value={query}
                        onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setOpen(true); }}
                        onFocus={() => setOpen(true)}
                        onBlur={() => setTimeout(() => setOpen(false), 150)}
                    />
                    {open && matches.length > 0 && (
                        <div class="umasSkillDropdown">
                            {matches.map(([id, name]) => {
                                const idStr = String(id);
                                const iconId = (skillmeta as any)[idStr]?.iconId;
                                const rarity: number = (skilldata as any)[idStr]?.rarity ?? 1;
                                const rarityClass = RARITY_CLASS[rarity] ?? 'umasRarity-white';
                                return (
                                    <div
                                        key={id}
                                        class={`umasSkillDropdownItem ${rarityClass}`}
                                        onMouseDown={() => add(id)}
                                    >
                                        {iconId && <img src={`/uma-tools/icons/${iconId}.png`} class="umasSkillChipIcon" loading="lazy" />}
                                        <span>{name}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function FilterPanel({ filters, onChange, availableSkills }: {
    filters: FilterState;
    onChange: (f: FilterState) => void;
    availableSkills: Map<number, string>;
}) {
    function setApt(key: AptKey, val: number) {
        onChange({ ...filters, aptMin: { ...filters.aptMin, [key]: val } });
    }
    function setSkills(ids: number[]) {
        onChange({ ...filters, skills: ids });
    }
    const aptVal = (key: AptKey) => filters.aptMin[key] ?? 0;

    return (
        <div class="umasFilterPanel">
            <div class="umasAptFilter">
                <div class="umasAptFilterRow">
                    <span class="umasAptRowLabel">Surf</span>
                    <AptFilterSelect aptKey="apt_turf"    label="Turf"   value={aptVal('apt_turf')}    onChange={setApt} />
                    <AptFilterSelect aptKey="apt_dirt"    label="Dirt"   value={aptVal('apt_dirt')}    onChange={setApt} />
                </div>
                <div class="umasAptFilterRow">
                    <span class="umasAptRowLabel">Dist</span>
                    <AptFilterSelect aptKey="apt_short"   label="Short"  value={aptVal('apt_short')}   onChange={setApt} />
                    <AptFilterSelect aptKey="apt_mile"    label="Mile"   value={aptVal('apt_mile')}    onChange={setApt} />
                    <AptFilterSelect aptKey="apt_middle"  label="Middle" value={aptVal('apt_middle')}  onChange={setApt} />
                    <AptFilterSelect aptKey="apt_long"    label="Long"   value={aptVal('apt_long')}    onChange={setApt} />
                </div>
                <div class="umasAptFilterRow">
                    <span class="umasAptRowLabel">Style</span>
                    <AptFilterSelect aptKey="apt_nige"    label="Front"  value={aptVal('apt_nige')}    onChange={setApt} />
                    <AptFilterSelect aptKey="apt_senko"   label="Pace"   value={aptVal('apt_senko')}   onChange={setApt} />
                    <AptFilterSelect aptKey="apt_sashi"   label="Late"   value={aptVal('apt_sashi')}   onChange={setApt} />
                    <AptFilterSelect aptKey="apt_oikomi"  label="End"    value={aptVal('apt_oikomi')}  onChange={setApt} />
                </div>
            </div>
            <div class="umasSkillFilterRow">
                <span class="umasAptRowLabel">Skills</span>
                <SkillPicker selected={filters.skills} onChange={setSkills} availableSkills={availableSkills} />
            </div>
            {panelFilterCount(filters) > 0 && (
                <button
                    class="umasFilterClearBtn"
                    onClick={() => onChange({ ...EMPTY_FILTERS, name: filters.name })}
                    type="button"
                >
                    ✕ Clear filters
                </button>
            )}
        </div>
    );
}

function SortControl({ sort, onSortChange }: {
    sort: SortState | null;
    onSortChange: (s: SortState | null) => void;
}) {
    const sortKeys = Object.keys(SORT_LABELS) as SortKey[];

    function handleKeyChange(e: Event) {
        const val = (e.target as HTMLSelectElement).value as SortKey;
        const s = sort ?? DEFAULT_SORT;
        onSortChange({ key: val, dir: s.dir });
    }

    function toggleDir() {
        const s = sort ?? DEFAULT_SORT;
        onSortChange({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' });
    }

    return (
        <div class="umasSortControl">
            <span class="umasSortLabel">Sort</span>
            <select class="umasSortSelect" value={(sort ?? DEFAULT_SORT).key} onChange={handleKeyChange}>
                {sortKeys.map(k => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
            </select>
            <button
                type="button"
                class="umasSortDirBtn"
                onClick={toggleDir}
                title={sort?.dir === 'asc' ? 'Ascending' : 'Descending'}
            >
                {sort?.dir === 'desc' ? '▼' : '▲'}
            </button>
        </div>
    );
}

function SearchBar({ name, onNameChange, filtersOpen, onToggleFilters, filterCount, sort, onSortChange }: {
    name: string;
    onNameChange: (v: string) => void;
    filtersOpen: boolean;
    onToggleFilters: () => void;
    filterCount: number;
    sort: SortState | null;
    onSortChange: (s: SortState | null) => void;
}) {
    return (
        <div class="umasSearchBar">
            <input
                type="search"
                class="umasSearchInput"
                placeholder="Search by name…"
                value={name}
                onInput={(e) => onNameChange((e.target as HTMLInputElement).value)}
            />
            <SortControl sort={sort} onSortChange={onSortChange} />
            <button
                class={`umasFiltersToggle${filtersOpen ? ' umasFiltersToggle--open' : ''}`}
                onClick={onToggleFilters}
                type="button"
            >
                Filters
                {filterCount > 0 && <span class="umasFilterBadge">{filterCount}</span>}
                <span class="umasFiltersChevron">{filtersOpen ? '▲' : '▼'}</span>
            </button>
        </div>
    );
}

function SkillGrid({ skills, cardId }: { skills: Array<{ id: number; level: number }>; cardId: number }) {
    const known = skills
        .filter(s => {
            const idStr = String(s.id);
            return (skillmeta as any)[idStr] && (skilldata as any)[idStr];
        })
        .sort((a, b) => skillOrder(String(a.id), String(b.id)));
    if (known.length === 0) return null;
    const totalSP = calcTotalSP(skills);
    return (
        <div class="umasSkillSection">
            <div class="umasSkillGrid">
                {known.map(s => {
                    const idStr = String(s.id);
                    const iconId = (skillmeta as any)[idStr]?.iconId;
                    const rarity: number = (skilldata as any)[idStr]?.rarity ?? 1;
                    const rarityClass = RARITY_CLASS[rarity] ?? 'skill-white';
                    if (!iconId) return null;
                    return (
                        <div key={idStr} class={`umasSkillPill ${rarityClass}`}>
                            <img class="umasSkillPillIcon" src={`/uma-tools/icons/${iconId}.png`} loading="lazy" />
                            <span class="umasSkillPillName"><Text id={`skillnames.${idStr}`} /></span>
                        </div>
                    );
                })}
            </div>
            <div class="umasSkillSpTotal">
                <span class="umasSkillSpTotalLabel">Total SP</span>
                <span class="umasSkillSpTotalValue">{totalSP.toLocaleString()}</span>
            </div>
        </div>
    );
}

interface UmaCardActions {
    onLoadUma1?: (uma: DecodedUma) => void;
    onLoadUma2?: (uma: DecodedUma) => void;
    onExport?: (uma: DecodedUma) => void;
}

function UmaCard({ uma, actions }: { uma: DecodedUma; actions: UmaCardActions }) {
    const { charName, outfitName, iconSrc } = getCharInfo(uma.card_id);
    const [copied, setCopied] = useState(false);

    function handleExport() {
        if (!actions.onExport) return;
        actions.onExport(uma);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div class="umaCard">
            <div class="umaCardHeader">
                <img class="umaCardPortrait" src={iconSrc} alt={charName} loading="lazy" />
                <div class="umaCardTitle">
                    <span class="umaCardName">{charName}</span>
                    {outfitName && <span class="umaCardOutfit">{outfitName}</span>}
                    {(uma.rank_score != null || uma.create_time) && (
                        <div class="umaCardMeta">
                            {uma.rank_score != null && <span class="umaCardMetaItem">Rating {uma.rank_score.toLocaleString()}</span>}
                            {uma.create_time && <span class="umaCardMetaItem">{uma.create_time}</span>}
                        </div>
                    )}
                </div>
                {(actions.onLoadUma1 || actions.onLoadUma2 || actions.onExport) && (
                    <div class="umaCardActions">
                        {actions.onLoadUma1 && (
                            <button class="umaCardActionBtn" onClick={() => actions.onLoadUma1!(uma)} type="button" title="Load into Uma 1">
                                Uma 1
                            </button>
                        )}
                        {actions.onLoadUma2 && (
                            <button class="umaCardActionBtn" onClick={() => actions.onLoadUma2!(uma)} type="button" title="Load into Uma 2">
                                Uma 2
                            </button>
                        )}
                        {actions.onExport && (
                            <button class={`umaCardActionBtn umaCardActionBtn--export${copied ? ' umaCardActionBtn--copied' : ''}`} onClick={handleExport} type="button" title={copied ? 'Copied!' : 'Copy JSON to clipboard'}>
                                {copied
                                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                }
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div class="umaCardStats">
                {([
                    ['speed',   'SPD', '/uma-tools/icons/status_00.png'],
                    ['stamina', 'STA', '/uma-tools/icons/status_01.png'],
                    ['power',   'PWR', '/uma-tools/icons/status_02.png'],
                    ['guts',    'GTS', '/uma-tools/icons/status_03.png'],
                    ['wisdom',  'WIS', '/uma-tools/icons/status_04.png'],
                ] as const).map(([key, label, catIcon]) => (
                    <div class="umaCardStat" key={key}>
                        <img class="umaStatCatIcon" src={catIcon} alt={label} />
                        <img class="umaStatRankIcon" src={`/uma-tools/icons/statusrank/ui_statusrank_${statRankStr(uma[key])}.png`} alt="" />
                        <span class="umaStatValue">{uma[key]}</span>
                    </div>
                ))}
            </div>

            <div class="umaCardApts">
                <div class="umasAptRow">
                    <span class="umasAptRowLabel">Surf</span>
                    <AptCell label="Turf"   value={uma.apt_turf} />
                    <AptCell label="Dirt"   value={uma.apt_dirt} />
                </div>
                <div class="umasAptRow">
                    <span class="umasAptRowLabel">Dist</span>
                    <AptCell label="Short"  value={uma.apt_short} />
                    <AptCell label="Mile"   value={uma.apt_mile} />
                    <AptCell label="Middle" value={uma.apt_middle} />
                    <AptCell label="Long"   value={uma.apt_long} />
                </div>
                <div class="umasAptRow">
                    <span class="umasAptRowLabel">Style</span>
                    <AptCell label="Front"  value={uma.apt_nige} />
                    <AptCell label="Pace"   value={uma.apt_senko} />
                    <AptCell label="Late"   value={uma.apt_sashi} />
                    <AptCell label="End"    value={uma.apt_oikomi} />
                </div>
            </div>

            <SkillGrid skills={uma.skills} cardId={uma.card_id} />
        </div>
    );
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadStoredUmas(): Promise<DecodedUma[]> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        return await loadRoster(raw);
    } catch {
        return [];
    }
}

// ── Main tab ─────────────────────────────────────────────────────────────────

export interface UmasTabProps {
    onLoadUma1?: (uma: DecodedUma) => void;
    onLoadUma2?: (uma: DecodedUma) => void;
    onExport?: (uma: DecodedUma) => void;
}

export function UmasTab({ onLoadUma1, onLoadUma2, onExport }: UmasTabProps = {}) {
    const [importedUmas, setImportedUmas] = useState<DecodedUma[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [importError, setImportError] = useState('');
    const [isImporting, setIsImporting] = useState(false);
    const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sort, setSort] = useState<SortState | null>(DEFAULT_SORT);
    const intlCtx = useContext(IntlContext as any) as any;
    const intlSkillNames: Record<string, string> = intlCtx?.intl?.dictionary?.skillnames ?? {};

    useEffect(() => {
        loadStoredUmas().then(data => { if (data.length > 0) setImportedUmas(data); });
    }, []);

    const handleImport = useCallback(async () => {
        if (!inputValue.trim()) return;
        setImportError('');
        setIsImporting(true);
        try {
            const decoded = await decodeRoster(inputValue);
            if (decoded.length === 0) {
                setImportError('Could not decode — please check the URL or code and try again.');
            } else {
                setImportedUmas(decoded);
                setInputValue('');
                saveRoster(decoded).then(encoded => localStorage.setItem(STORAGE_KEY, encoded));
            }
        } catch (e: any) {
            setImportError('Decode failed: ' + (e?.message ?? 'Unknown error'));
        } finally {
            setIsImporting(false);
        }
    }, [inputValue]);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleImport();
        }
    }, [handleImport]);

    const handleClear = useCallback(() => {
        setImportedUmas([]);
        setFilters(EMPTY_FILTERS);
        localStorage.removeItem(STORAGE_KEY);
    }, []);

    const availableSkills = useMemo(() => buildSkillIndex(importedUmas, intlSkillNames), [importedUmas, intlSkillNames]);

    const visible = useMemo(() => {
        const filtered = filterUmas(importedUmas, filters);
        const effectiveSort = sort ?? DEFAULT_SORT;
        return [...filtered].sort((a, b) => {
            if (effectiveSort.key === 'sp') {
                const valA = calcTotalSP(a.skills);
                const valB = calcTotalSP(b.skills);
                return effectiveSort.dir === 'asc' ? valA - valB : valB - valA;
            }
            if (effectiveSort.key === 'time') {
                const tA = a.create_time ?? '';
                const tB = b.create_time ?? '';
                if (!tA && !tB) return 0;
                if (!tA) return 1;
                if (!tB) return -1;
                const cmp = tB.localeCompare(tA);
                return effectiveSort.dir === 'asc' ? -cmp : cmp;
            }
            if (effectiveSort.key === 'rating') {
                const rA = a.rank_score ?? -1;
                const rB = b.rank_score ?? -1;
                if (rA < 0 && rB < 0) return 0;
                if (rA < 0) return 1;
                if (rB < 0) return -1;
                return effectiveSort.dir === 'asc' ? rA - rB : rB - rA;
            }
            return 0;
        });
    }, [importedUmas, filters, sort]);

    const badgeCount = panelFilterCount(filters);
    const showCount = isFilterActive(filters) && importedUmas.length > 0;

    return (
        <div id="umasTab">
            <div class="umasImportBar">
                <div class="umasImportInputRow">
                    <input
                        type="text"
                        class="umasImportInput"
                        placeholder="Paste your roster URL or code from roster.uma.guide…"
                        value={inputValue}
                        onInput={(e) => setInputValue((e.target as HTMLInputElement).value)}
                        onKeyDown={handleKeyDown}
                        disabled={isImporting}
                    />
                    <button class="umasImportBtn" onClick={handleImport} disabled={isImporting || !inputValue.trim()}>
                        {isImporting ? 'Importing…' : 'Import'}
                    </button>
                    {importedUmas.length > 0 && (
                        <button class="umasClearAllBtn" onClick={handleClear} title="Remove all imported umas">
                            Clear
                        </button>
                    )}
                </div>
                {importError && <p class="umasImportError">{importError}</p>}
                <p class="umasImportHint">
                    Export your trained umas at{' '}
                    <a href="https://roster.uma.guide/" target="_blank" rel="noopener">roster.uma.guide</a>
                    {' '}— paste the full URL here to load your roster.
                    {importedUmas.length > 0 && (
                        <span class="umasLoadedCount"> {importedUmas.length} uma{importedUmas.length !== 1 ? 's' : ''} loaded.</span>
                    )}
                </p>
            </div>

            {importedUmas.length > 0 && (
                <div class="umasSearchSection">
                    <SearchBar
                        name={filters.name}
                        onNameChange={(v) => setFilters(f => ({ ...f, name: v }))}
                        filtersOpen={filtersOpen}
                        onToggleFilters={() => setFiltersOpen(o => !o)}
                        filterCount={badgeCount}
                        sort={sort}
                        onSortChange={setSort}
                    />
                    {filtersOpen && (
                        <FilterPanel
                            filters={filters}
                            onChange={setFilters}
                            availableSkills={availableSkills}
                        />
                    )}
                </div>
            )}

            {importedUmas.length > 0 ? (
                <>
                    {showCount && (
                        <p class="umasResultCount">
                            Showing <strong>{visible.length}</strong> of {importedUmas.length} umas
                        </p>
                    )}
                    {visible.length > 0 ? (
                        <div class="umasGrid">
                            {visible.map((uma, i) => (
                                <UmaCard key={`${uma.card_id}-${i}`} uma={uma} actions={{ onLoadUma1, onLoadUma2, onExport }} />
                            ))}
                        </div>
                    ) : (
                        <div class="umasEmpty">
                            <p>No umas match your filters.</p>
                        </div>
                    )}
                </>
            ) : (
                <div class="umasEmpty">
                    <p>No roster loaded. Paste a URL above to get started.</p>
                </div>
            )}
        </div>
    );
}
