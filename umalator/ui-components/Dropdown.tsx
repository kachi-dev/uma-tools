import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

import './Dropdown.css';

export interface DropdownItem {
    label?: string;
    icon?: any;
    suffix?: any;
    onClick?: () => void;
    divider?: boolean;
    disabled?: boolean;
}

interface DropdownProps {
    trigger: any;
    items: DropdownItem[];
    align?: 'left' | 'right';
}

interface MenuPos {
    top: number;
    left?: number;
    right?: number;
}

export function Dropdown({ trigger, items, align = 'right' }: DropdownProps) {
    const [open, setOpen] = useState(false);
    const [menuPos, setMenuPos] = useState<MenuPos>({ top: 0 });
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        function handleClick(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    function handleToggle() {
        if (open) { setOpen(false); return; }
        if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            if (align === 'right') {
                setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
            } else {
                setMenuPos({ top: rect.bottom + 4, left: rect.left });
            }
        }
        setOpen(true);
    }

    function handleItemClick(item: DropdownItem) {
        if (item.disabled || !item.onClick) return;
        item.onClick();
        setOpen(false);
    }

    const menuStyle = open
        ? `position:fixed;top:${menuPos.top}px;${menuPos.right !== undefined ? `right:${menuPos.right}px` : `left:${menuPos.left}px`};z-index:1000`
        : '';

    return (
        <div class="dropdown" ref={containerRef}>
            <div class="dropdownTrigger" ref={triggerRef} onClick={handleToggle}>
                {trigger}
            </div>
            {open && (
                <div class="dropdownMenu" style={menuStyle}>
                    {items.map((item, i) => {
                        if (item.divider) return <div key={i} class="dropdownDivider" />;
                        return (
                            <div
                                key={i}
                                class={`dropdownItem ${item.disabled ? 'dropdownItemDisabled' : ''}`}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => handleItemClick(item)}
                            >
                                {item.icon && <span class="dropdownItemIcon">{item.icon}</span>}
                                <span class="dropdownItemLabel">{item.label}</span>
                                {item.suffix && <span class="dropdownItemSuffix">{item.suffix}</span>}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
