import { h } from 'preact';
import { useMemo, useContext } from 'preact/hooks';
import { IntlContext } from 'preact-i18n';
import { Clock, Zap, Heart, Swords, Flag, TrendingUp } from 'lucide-preact';
import './ResultsPane.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface AggregatedStats {
    min: number;
    max: number;
    mean: number;
    frequency: number;
}

interface AllRunsData {
    sk: [Map<string, number[][]> | Record<string, number[][]>, Map<string, number[][]> | Record<string, number[][]>];
    skBasinn: [Map<string, [number, number][]> | Record<string, [number, number][]>, Map<string, [number, number][]> | Record<string, [number, number][]>];
    totalRuns: number;
    rushed: [AggregatedStats, AggregatedStats];
    leadCompetition: [AggregatedStats, AggregatedStats];
    competeFight: [AggregatedStats, AggregatedStats];
}

interface RaceSnapshot {
    t: [number[], number[]];
    p: [number[], number[]];
    v: [number[], number[]];
    hp: [number[], number[]];
    sk: [Map<string, number[][]> | Record<string, number[][]>, Map<string, number[][]> | Record<string, number[][]>];
    sdly: [number, number];
    rushed: [[number, number][], [number, number][]];
    posKeep: any[];
    competeFight: [[number, number], [number, number]];
    leadCompetition: [[number, number], [number, number]];
    downhillActivations: [[number, number][], [number, number][]];
    pacerGap?: [(number | undefined)[], (number | undefined)[]];
}

interface PositionStats {
    count: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
}

interface UmaStaminaStats {
    staminaSurvivalRate: number;
    fullSpurtRate: number;
    hpDiedPositionStatsFullSpurt: PositionStats;
    hpDiedPositionStatsNonFullSpurt: PositionStats;
    nonFullSpurtVelocityStats: PositionStats;
    nonFullSpurtDelayStats: PositionStats;
}

interface FirstUmaStats {
    uma1: { firstPlaceRate: number };
    uma2: { firstPlaceRate: number };
}

export interface CompareResults {
    results: number[];
    runData: {
        minrun: RaceSnapshot;
        maxrun: RaceSnapshot;
        meanrun: RaceSnapshot;
        medianrun: RaceSnapshot;
        allruns: AllRunsData;
    };
    staminaStats: {
        uma1: UmaStaminaStats;
        uma2: UmaStaminaStats;
    };
    firstUmaStats: FirstUmaStats;
}

export interface ResultsPaneProps {
    results: CompareResults | null;
    isRunning: boolean;
    progress?: number;
    courseId?: string | number;
    displayRun: 'mean' | 'median' | 'min' | 'max';
    onDisplayRunChange: (run: 'mean' | 'median' | 'min' | 'max') => void;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}:${remaining.toFixed(3).padStart(6, '0')}`;
}

function formatBashin(bashin: number): string {
    const sign = bashin >= 0 ? '+' : '';
    return `${sign}${bashin.toFixed(2)}L`;
}

function calcStats(results: number[]) {
    const sorted = [...results].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    return { min, max, mean, median };
}

function getFinishTime(snapshot: RaceSnapshot, umaIndex: 0 | 1): number {
    const times = snapshot.t[umaIndex];
    return times[times.length - 1] || 0;
}

function getMaxVelocity(snapshot: RaceSnapshot, umaIndex: 0 | 1): number {
    return Math.max(...snapshot.v[umaIndex]);
}

function getSkillName(skillId: string, dict: Record<string, string>): string {
    return dict[skillId] ?? skillId;
}

function skillEntries(sk: Map<string, number[][]> | Record<string, number[][]>): [string, number[][]][] {
    if (sk instanceof Map) return Array.from(sk.entries());
    return Object.entries(sk as Record<string, number[][]>);
}

function skillSize(sk: Map<string, number[][]> | Record<string, number[][]>): number {
    if (sk instanceof Map) return sk.size;
    return Object.keys(sk).length;
}

// ── ResultsSummary ────────────────────────────────────────────────────────────

interface ResultsSummaryProps {
    results: number[];
    displayRun: 'mean' | 'median' | 'min' | 'max';
    onDisplayRunChange: (run: 'mean' | 'median' | 'min' | 'max') => void;
}

function ResultsSummary({ results, displayRun, onDisplayRunChange }: ResultsSummaryProps) {
    const stats = useMemo(() => calcStats(results), [results]);

    const entries: Array<{ key: 'min' | 'max' | 'mean' | 'median'; label: string }> = [
        { key: 'min', label: 'Min' },
        { key: 'max', label: 'Max' },
        { key: 'mean', label: 'Mean' },
        { key: 'median', label: 'Median' },
    ];

    return (
        <div class="results-summary">
            {entries.map(({ key, label }) => (
                <div
                    key={key}
                    class={`results-stat${displayRun === key ? ' highlight' : ''}`}
                    onClick={() => onDisplayRunChange(key)}
                >
                    <span class="results-stat-label">{label}</span>
                    <span class={`results-stat-value ${stats[key] <= 0 ? 'uma1' : 'uma2'}`}>
                        {formatBashin(stats[key])}
                    </span>
                </div>
            ))}
            <div class="results-stat muted">
                <span class="results-stat-label">Samples</span>
                <span class="results-stat-value" style="color: var(--rp-text-secondary)">
                    {results.length}
                </span>
            </div>
        </div>
    );
}

// ── Histogram ─────────────────────────────────────────────────────────────────

interface HistogramProps {
    results: number[];
    displayRun: 'mean' | 'median' | 'min' | 'max';
    width?: number;
    height?: number;
}

function Histogram({ results, displayRun, width = 500, height = 80 }: HistogramProps) {
    if (results.length === 0) {
        return <div class="histogram-empty">No data</div>;
    }

    const stats = calcStats(results);
    const markerValue = stats[displayRun];

    const NUM_BINS = 30;
    const PAD = { top: 4, bottom: 20, left: 4, right: 4 };
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;

    const minVal = results[0];
    const maxVal = results[results.length - 1];
    const range = maxVal - minVal || 1;
    const binWidth = range / NUM_BINS;

    const bins = Array.from({ length: NUM_BINS }, () => 0);
    for (const v of results) {
        const idx = Math.min(Math.floor((v - minVal) / binWidth), NUM_BINS - 1);
        bins[idx]++;
    }
    const maxCount = Math.max(...bins, 1);

    const xScale = (v: number) => PAD.left + ((v - minVal) / range) * innerW;
    const zeroX = minVal <= 0 && maxVal >= 0 ? xScale(0) : null;
    const markerX = xScale(markerValue);
    const barW = innerW / NUM_BINS;

    return (
        <div class="results-histogram">
            <svg class="histogram-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                {bins.map((count, i) => {
                    const x = PAD.left + i * barW;
                    const barH = (count / maxCount) * innerH;
                    const y = PAD.top + innerH - barH;
                    const binCenter = minVal + (i + 0.5) * binWidth;
                    return (
                        <rect
                            key={i}
                            class={binCenter <= 0 ? 'bar-uma1' : 'bar-uma2'}
                            x={x + 0.5}
                            y={y}
                            width={Math.max(barW - 1, 1)}
                            height={barH}
                        />
                    );
                })}
                {zeroX !== null && (
                    <line class="histogram-zero-line" x1={zeroX} y1={PAD.top} x2={zeroX} y2={PAD.top + innerH} />
                )}
                <line class="histogram-marker-line" x1={markerX} y1={PAD.top} x2={markerX} y2={PAD.top + innerH} />
                <text class="histogram-axis-label" x={PAD.left} y={height - 4} text-anchor="start">
                    {formatBashin(minVal)}
                </text>
                <text class="histogram-axis-label" x={width - PAD.right} y={height - 4} text-anchor="end">
                    {formatBashin(maxVal)}
                </text>
            </svg>
        </div>
    );
}

// ── UmaStatsCard ──────────────────────────────────────────────────────────────

interface UmaStatsCardProps {
    snapshot: RaceSnapshot;
    allruns: AllRunsData;
    staminaStats: UmaStaminaStats;
    firstPlaceRate: number;
    umaIndex: 0 | 1;
}

function UmaStatsCard({ snapshot, allruns, staminaStats, firstPlaceRate, umaIndex }: UmaStatsCardProps) {
    const label = umaIndex === 0 ? 'Uma 1' : 'Uma 2';
    const cls = umaIndex === 0 ? 'uma1' : 'uma2';
    const skillNameDict: Record<string, string> = (useContext(IntlContext as any) as any)?.intl?.dictionary?.skillnames ?? {};

    const finishTime = formatTime(getFinishTime(snapshot, umaIndex) * 1.18);
    const maxV = getMaxVelocity(snapshot, umaIndex).toFixed(2);
    const startDelay = snapshot.sdly[umaIndex].toFixed(3);

    const rushed = allruns.rushed[umaIndex];
    const leadComp = allruns.leadCompetition[umaIndex];
    const duel = allruns.competeFight[umaIndex];
    const showMechanics = rushed.frequency > 0 || leadComp.frequency > 0 || duel.frequency > 0;

    const skillMap = snapshot.sk[umaIndex];
    const showSkills = skillSize(skillMap) > 0;

    return (
        <div class={`uma-stats-card ${cls}`}>
            <div class="uma-stats-header">
                <span class="uma-stats-label">{label}</span>
            </div>
            <div class="uma-stats-details">
                <div class="stats-primary">
                    <div class="stat-item">
                        <Clock size={14} />
                        <span class="value">{finishTime}</span>
                        <span class="label">Finish</span>
                    </div>
                    <div class="stat-item">
                        <Zap size={14} />
                        <span class="value">{maxV}</span>
                        <span class="label">Max m/s</span>
                    </div>
                    <div class="stat-item">
                        <Heart size={14} />
                        <span class="value">{staminaStats.fullSpurtRate.toFixed(1)}%</span>
                        <span class="label">Spurt Rate</span>
                    </div>
                    <div class="stat-item">
                        <Heart size={14} />
                        <span class="value">{staminaStats.staminaSurvivalRate.toFixed(1)}%</span>
                        <span class="label">Survival</span>
                    </div>
                </div>

                <div class="stats-secondary">
                    <div class="stat-row">
                        <span class="label">Start Delay</span>
                        <span class="value">{startDelay}s</span>
                    </div>
                </div>

                {showMechanics && (
                    <div class="mechanics-section">
                        <h4>Race Mechanics</h4>
                        {rushed.frequency > 0 && (
                            <div class="stat-row">
                                <span class="label"><TrendingUp size={12} /> Rushed</span>
                                <span class="value">{rushed.frequency.toFixed(1)}% ({rushed.mean.toFixed(0)}m)</span>
                            </div>
                        )}
                        {leadComp.frequency > 0 && (
                            <div class="stat-row">
                                <span class="label"><Flag size={12} /> Spot Struggle</span>
                                <span class="value">{leadComp.frequency.toFixed(1)}%</span>
                            </div>
                        )}
                        {duel.frequency > 0 && (
                            <div class="stat-row">
                                <span class="label"><Swords size={12} /> Dueling</span>
                                <span class="value">{duel.frequency.toFixed(1)}%</span>
                            </div>
                        )}
                    </div>
                )}

                <div class="misc-section">
                    <h4>Miscellaneous</h4>
                    <div class="stat-row">
                        <span class="label">1st into Late Race</span>
                        <span class="value">{firstPlaceRate.toFixed(1)}%</span>
                    </div>
                    {staminaStats.hpDiedPositionStatsNonFullSpurt.count > 0 && (
                        <div class="stat-row">
                            <span class="label">Failed Spurt HP Die Pos</span>
                            <span class="value">
                                {staminaStats.hpDiedPositionStatsNonFullSpurt.mean?.toFixed(0)}m
                                <span class="stat-subtext">
                                    {' '}({staminaStats.hpDiedPositionStatsNonFullSpurt.min?.toFixed(0)} – {staminaStats.hpDiedPositionStatsNonFullSpurt.max?.toFixed(0)},
                                    {' '}{((staminaStats.hpDiedPositionStatsNonFullSpurt.count / (allruns.totalRuns || 1)) * 100).toFixed(1)}% of runs)
                                </span>
                            </span>
                        </div>
                    )}
                    {staminaStats.hpDiedPositionStatsFullSpurt.count > 0 && (
                        <div class="stat-row">
                            <span class="label">Spurt HP Die Pos</span>
                            <span class="value">
                                {staminaStats.hpDiedPositionStatsFullSpurt.mean?.toFixed(0)}m
                                <span class="stat-subtext">
                                    {' '}({staminaStats.hpDiedPositionStatsFullSpurt.min?.toFixed(0)} – {staminaStats.hpDiedPositionStatsFullSpurt.max?.toFixed(0)},
                                    {' '}{((staminaStats.hpDiedPositionStatsFullSpurt.count / (allruns.totalRuns || 1)) * 100).toFixed(1)}% of runs)
                                </span>
                            </span>
                        </div>
                    )}
                    {staminaStats.nonFullSpurtVelocityStats.count > 0 && (
                        <div class="stat-row">
                            <span class="label">Failed Spurt Velocity</span>
                            <span class="value">
                                {staminaStats.nonFullSpurtVelocityStats.mean?.toFixed(2)} m/s
                                <span class="stat-subtext">
                                    {' '}({staminaStats.nonFullSpurtVelocityStats.min?.toFixed(2)} – {staminaStats.nonFullSpurtVelocityStats.max?.toFixed(2)})
                                </span>
                            </span>
                        </div>
                    )}
                    {staminaStats.nonFullSpurtDelayStats.count > 0 && (
                        <div class="stat-row">
                            <span class="label">Failed Spurt Delay</span>
                            <span class="value">
                                {staminaStats.nonFullSpurtDelayStats.mean?.toFixed(2)}s
                                <span class="stat-subtext">
                                    {' '}({staminaStats.nonFullSpurtDelayStats.min?.toFixed(2)} – {staminaStats.nonFullSpurtDelayStats.max?.toFixed(2)})
                                </span>
                            </span>
                        </div>
                    )}
                </div>

                {showSkills && (
                    <div class="skills-section">
                        <h4>Skills ({skillSize(skillMap)})</h4>
                        <div class="skill-activations">
                            {skillEntries(skillMap).map(([skillId, activations]) =>
                                activations.map((pos, i) => (
                                    <div key={`${skillId}-${i}`} class="skill-activation">
                                        <span class="skill-name" title={getSkillName(skillId, skillNameDict)}>
                                            {getSkillName(skillId, skillNameDict)}
                                        </span>
                                        <span class="skill-pos">
                                            {pos[1] === -1
                                                ? `${pos[0].toFixed(0)}m`
                                                : `${pos[0].toFixed(0)}m – ${pos[1].toFixed(0)}m`}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── ResultsPane ───────────────────────────────────────────────────────────────

export function ResultsPane({
    results,
    isRunning,
    progress,
    displayRun,
    onDisplayRunChange,
}: ResultsPaneProps) {
    if (results === null) {
        if (!isRunning) return null;
        return (
            <div class="results-pane results-pane--empty">
                <div class="results-running">
                    <div class="results-spinner" />
                    <span>{progress != null ? `Running… ${progress}%` : 'Running…'}</span>
                </div>
            </div>
        );
    }

    const { runData, staminaStats, firstUmaStats } = results;
    const runKey = `${displayRun}run` as keyof typeof runData;
    const snapshot = runData[runKey] as RaceSnapshot;

    return (
        <div class="results-pane">
            <ResultsSummary
                results={results.results}
                displayRun={displayRun}
                onDisplayRunChange={onDisplayRunChange}
            />

            <Histogram results={results.results} displayRun={displayRun} />

            <div class="run-selector">
                <span class="run-selector-label">View run:</span>
                {(['min', 'max', 'mean', 'median'] as const).map(key => (
                    <button
                        key={key}
                        class={displayRun === key ? 'active' : ''}
                        onClick={() => onDisplayRunChange(key)}
                    >
                        {key.charAt(0).toUpperCase() + key.slice(1)}
                    </button>
                ))}
            </div>

            {snapshot && (
                <div class="uma-stats-container">
                    <UmaStatsCard
                        snapshot={snapshot}
                        allruns={runData.allruns}
                        staminaStats={staminaStats.uma1}
                        firstPlaceRate={firstUmaStats.uma1.firstPlaceRate}
                        umaIndex={0}
                    />
                    <UmaStatsCard
                        snapshot={snapshot}
                        allruns={runData.allruns}
                        staminaStats={staminaStats.uma2}
                        firstPlaceRate={firstUmaStats.uma2.firstPlaceRate}
                        umaIndex={1}
                    />
                </div>
            )}
        </div>
    );
}
