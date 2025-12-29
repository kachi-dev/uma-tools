import { h, Fragment } from 'preact';
import { useState, useMemo, useId, useRef } from 'preact/hooks';
import { Text, Localizer } from 'preact-i18n';

import {
	ColumnDef, SortFn, SortingState,
	createSortedRowModel, flexRender, rowSortingFeature, sortFns, tableFeatures, useTable
} from '@tanstack/preact-table';

import { Region, RegionList } from '../uma-skill-tools/Region';
import { CourseData } from '../uma-skill-tools/CourseData';
import { RaceParameters } from '../uma-skill-tools/RaceParameters';
import { getParser } from '../uma-skill-tools/ConditionParser';
import { buildBaseStats, buildSkillData, Perspective } from '../uma-skill-tools/RaceSolverBuilder';

import type { HorseState } from '../components/HorseDef';
import { runComparison } from './compare';

import './BasinnChart.css';

import skilldata from '../uma-skill-tools/data/skill_data.json';
import skillnames from '../uma-skill-tools/data/skillnames.json';
import skillmeta from '../skill_meta.json';
import umas from '../umas.json';
import icons from '../icons.json';

export function isPurpleSkill(id) {
	const iconId = skillmeta[id].iconId;
	return iconId[iconId.length-1] == '4';
}

function umaForUniqueSkill(skillId: string): string | null {
	const sid = parseInt(skillId);
	if (sid < 100000 || sid >= 200000) return null;
	
	const remainder = sid - 100001;
	if (remainder < 0) return null;
	
	const i = Math.floor(remainder / 10) % 1000;
	const v = Math.floor(remainder / 10 / 1000) + 1;
	
	const umaId = i.toString().padStart(3, '0');
	const baseUmaId = `1${umaId}`;
	const outfitId = `${baseUmaId}${v.toString().padStart(2, '0')}`;
	
	if (umas[baseUmaId] && umas[baseUmaId].outfits[outfitId]) {
		return outfitId;
	}
	
	return null;
}

export function getActivateableSkills(skills: string[], horse: HorseState, course: CourseData, racedef: RaceParameters) {
	const parser = getParser();
	const h2 = buildBaseStats(horse, horse.mood);
	const wholeCourse = new RegionList();
	wholeCourse.push(new Region(0, course.distance));
	return skills.filter(id => {
		let sd;
		try {
			sd = buildSkillData(h2, racedef, course, wholeCourse, parser, id, Perspective.Any);
		} catch (_) {
			return false;
		}
		return sd.some(trigger => trigger.regions.length > 0 && trigger.regions[0].start < 9999);
	});
}

export function getNullRow(skillid: string) {
	return {id: skillid, min: 0, max: 0, mean: 0, median: 0, results: [], runData: null};
}

function formatBasinn(info) {
	return info.getValue().toFixed(2).replace('-0.00', '0.00') + ' L';
}

function SkillNameCell(props) {
	const { id, showUmaIcons = false } = props;
	
	if (showUmaIcons) {
		const umaId = umaForUniqueSkill(id);
		if (umaId && icons[umaId]) {
			return (
				<div class="chartSkillName">
					<img src={icons[umaId]} />
					<span><Text id={`skillnames.${id}`} /></span>
				</div>
			);
		}
	}
	
	return (
		<div class="chartSkillName">
			<img src={`/uma-tools/icons/${skillmeta[id].iconId}.png`} />
			<span><Text id={`skillnames.${id}`} /></span>
		</div>
	);
}

function headerRenderer(radioGroup, selectedType, type, text, onClick) {
	function click(e) {
		e.stopPropagation();
		onClick(type);
	}
	return (c) => (
		<div>
			<input type="radio" name={radioGroup} checked={selectedType == type} title={`Show ${text.toLowerCase()} on chart`} onClick={click} />
			<span onClick={c.header.column.getToggleSortingHandler()}>{text}</span>
		</div>
	);
}

export function BasinnChart(props) {
	const radioGroup = useId();
	const [expanded, setExpanded] = useState('');
	const [selectedType, setSelectedType] = useState('median');
	const clickTimeoutRef = useRef(null);
	const lastClickRef = useRef({id: '', time: 0});

	function headerClick(type) {
		setSelectedType(type);
		props.onRunTypeChange(type + 'run');
	}

	function toggleExpand(skillId) {
		if (expanded === skillId) {
			setExpanded('');
			props.onSelectionChange('');
		} else {
			setExpanded(skillId);
			props.onSelectionChange(skillId);
		}
	}

	const columns = useMemo(() => [{
		header: () => <span>Skill name</span>,
		accessorKey: 'id',
		cell: (info) => <SkillNameCell id={info.getValue()} showUmaIcons={props.showUmaIcons} />,
		sortingFn: (a,b,_) => skillnames[a] < skillnames[b] ? -1 : 1
	}, {
		header: headerRenderer(radioGroup, selectedType, 'min', 'Minimum', headerClick),
		accessorKey: 'min',
		cell: formatBasinn
	}, {
		header: headerRenderer(radioGroup, selectedType, 'max', 'Maximum', headerClick),
		accessorKey: 'max',
		cell: formatBasinn,
		sortDescFirst: true
	}, {
		header: headerRenderer(radioGroup, selectedType, 'mean', 'Mean', headerClick),
		accessorKey: 'mean',
		cell: formatBasinn,
		sortDescFirst: true
	}, {
		header: headerRenderer(radioGroup, selectedType, 'median', 'Median', headerClick),
		accessorKey: 'median',
		cell: formatBasinn,
		sortDescFirst: true
	}], [selectedType, props.showUmaIcons]);

	const [sorting, setSorting] = useState<SortingState>([{id: 'median', desc: true}]);

	const table = useTable({
		_features: tableFeatures({rowSortingFeature}),
		_rowModels: {sortedRowModel: createSortedRowModel(sortFns)},
		columns,
		data: props.data,
		onSortingChange: setSorting,
		enableSortingRemoval: false,
		state: {sorting}
	});

	function handleClick(e) {
		const tr = e.target.closest('tr');
		if (tr == null) return;
		e.stopPropagation();
		const id = tr.dataset.skillid;
		if (e.target.tagName == 'IMG') {
			props.onInfoClick(id);
			return;
		}
		
		const now = Date.now();
		const isDoubleClick = lastClickRef.current.id === id && (now - lastClickRef.current.time) < 300;
		
		if (clickTimeoutRef.current) {
			clearTimeout(clickTimeoutRef.current);
			clickTimeoutRef.current = null;
			if (!isDoubleClick) {
				toggleExpand(id);
			}
			return;
		}
		
		lastClickRef.current = {id, time: now};
		clickTimeoutRef.current = setTimeout(() => {
			clickTimeoutRef.current = null;
			if (lastClickRef.current.id === id && (Date.now() - lastClickRef.current.time) >= 300) {
				toggleExpand(id);
			}
		}, 300);
	}

	function handleDblClick(e) {
		if (clickTimeoutRef.current) {
			clearTimeout(clickTimeoutRef.current);
			clickTimeoutRef.current = null;
		}
		const tr = e.target.closest('tr');
		if (tr == null) return;
		e.stopPropagation();
		e.preventDefault();
		const id = tr.dataset.skillid;
		if (e.target.tagName == 'IMG') {
			return;
		}
		if (expanded === id) {
			return;
		}
		lastClickRef.current = {id: '', time: 0};
		props.onDblClickRow(id);
	}

	return (
		<div class={`basinnChartWrapper${props.dirty ? ' dirty' : ''}`}>
			<table class="basinnChart">
				<thead>
					{table.getHeaderGroups().map(headerGroup => (
						<tr key={headerGroup.id}>
							{headerGroup.headers.map(header => (
								<th key={header.id} colSpan={header.colSpan}>
									{!header.isPlaceholder && (
										<div
											class={`columnHeader ${({
												'asc': 'basinnChartSortedAsc',
												'desc': 'basinnChartSortedDesc',
												'false': ''
											})[header.column.getIsSorted()]}`}
											title={header.column.getCanSort() &&
												({
													'asc': 'Sort ascending',
													'desc': 'Sort descending',
													'false': 'Clear sort'
												})[header.column.getNextSortingOrder()]}>
											{flexRender(header.column.columnDef.header, header.getContext())}
										</div>
									)}
								</th>
							))}
						</tr>
					))}
				</thead>
				<tbody onClick={handleClick} onDblClick={handleDblClick}>
					{table.getRowModel().rows.map(row => {
						const id = row.getValue('id');
						const isExpanded = expanded === id;
						const rowData = props.data.find(d => d.id === id);
						return (
							<Fragment key={row.id}>
								<tr data-skillid={id} class={isExpanded ? 'expanded' : ''} style={props.hidden.has(id) && 'display:none'}>
									{row.getAllCells().map(cell => (
										<td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
									))}
								</tr>
								{isExpanded && rowData && rowData.runData && props.expandedContent && (
									<tr class="expanded-content-row" data-skillid={id}>
										<td colSpan={row.getAllCells().length}>
											{props.expandedContent(id, rowData.runData, props.courseDistance)}
										</td>
									</tr>
								)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
