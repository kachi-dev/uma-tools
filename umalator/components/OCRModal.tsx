import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { Upload, ArrowLeft, Check, Loader2, ExternalLink, ImageIcon } from 'lucide-preact';

import { AptitudeSelect, StrategySelect } from '../../components/HorseDef';
import { extractHorseDataFromImage, fileToBase64, mapSkillNamesToIds, mapOutfitNameToId, mapCharacterNameToOutfitId, OCRHorseData } from '../GeminiOCR';
import { getStoredApiKey, storeApiKey } from '../storage';
import { UmaState } from '../storage';

import './OCRModal.css';

interface OCRModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (state: UmaState) => void;
}

function ocrDataToUmaState(data: OCRHorseData): UmaState {
    let outfitId = mapOutfitNameToId(data.outfit);
    if (!outfitId && data.name) {
        outfitId = mapCharacterNameToOutfitId(data.name);
    }
    return {
        outfitId: outfitId || '',
        speed:    data.speed    || 1200,
        stamina:  data.stamina  || 1200,
        power:    data.power    || 800,
        guts:     data.guts     || 400,
        wisdom:   data.wisdom   || 400,
        strategy:          (data.strategy as any) || 'Senkou',
        distanceAptitude:  (data.distanceAptitude as any) || 'A',
        surfaceAptitude:   (data.surfaceAptitude as any)  || 'A',
        strategyAptitude:  (data.strategyAptitude as any) || 'A',
        mood: 2,
        skills: mapSkillNamesToIds(data.skills || []),
        forcedSkillPositions: {},
    };
}

export function OCRModal({ isOpen, onClose, onConfirm }: OCRModalProps) {
    const [step, setStep] = useState<'upload' | 'review'>('upload');
    const [apiKey, setApiKey] = useState('');
    const [imageFile, setImageFile] = useState<File | null>(null);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    const [isExtracting, setIsExtracting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [ocrData, setOcrData] = useState<OCRHorseData | null>(null);
    const [editedAptitudes, setEditedAptitudes] = useState({
        surfaceAptitude: 'A',
        distanceAptitude: 'A',
        strategyAptitude: 'A',
    });
    const [editedStrategy, setEditedStrategy] = useState('Senkou');

    const fileInputRef = useRef<HTMLInputElement>(null);
    const dropzoneRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        const stored = getStoredApiKey();
        if (stored) setApiKey(stored);
        setStep('upload');
        setImageFile(null);
        setImagePreview(null);
        setError(null);
        setOcrData(null);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        function handlePaste(e: ClipboardEvent) {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) loadImageFile(file);
                    break;
                }
            }
        }
        document.addEventListener('paste', handlePaste);
        return () => document.removeEventListener('paste', handlePaste);
    }, [isOpen]);

    function loadImageFile(file: File) {
        setImageFile(file);
        setError(null);
        const reader = new FileReader();
        reader.onload = () => setImagePreview(reader.result as string);
        reader.readAsDataURL(file);
    }

    function handleDropzoneClick() {
        fileInputRef.current?.click();
    }

    function handleFileChange(e: Event) {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) loadImageFile(file);
    }

    function handleDragOver(e: DragEvent) {
        e.preventDefault();
        setIsDragOver(true);
    }

    function handleDragLeave() {
        setIsDragOver(false);
    }

    function handleDrop(e: DragEvent) {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer?.files[0];
        if (file && file.type.startsWith('image/')) loadImageFile(file);
    }

    async function handleExtract() {
        if (!imageFile) { setError('Please select an image first.'); return; }
        if (!apiKey.trim()) { setError('Please enter your Gemini API key.'); return; }

        setIsExtracting(true);
        setError(null);

        storeApiKey(apiKey.trim());

        try {
            const { base64, mimeType } = await fileToBase64(imageFile);
            const result = await extractHorseDataFromImage(base64, mimeType, apiKey.trim());

            if (!result.success || !result.data) {
                setError(result.error || 'Extraction failed.');
            } else {
                setOcrData(result.data);
                setEditedAptitudes({
                    surfaceAptitude: result.data.surfaceAptitude || 'A',
                    distanceAptitude: result.data.distanceAptitude || 'A',
                    strategyAptitude: result.data.strategyAptitude || 'A',
                });
                setEditedStrategy(result.data.strategy || 'Senkou');
                setStep('review');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setIsExtracting(false);
        }
    }

    function handleConfirm() {
        if (!ocrData) return;
        const merged: OCRHorseData = {
            ...ocrData,
            ...editedAptitudes,
            strategy: editedStrategy,
        };
        onConfirm(ocrDataToUmaState(merged));
        onClose();
    }

    if (!isOpen) return null;

    return (
        <div class="ocrOverlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div class="ocrModal">
                <div class="ocrModalHeader">
                    <h2 class="ocrModalTitle">Import from Screenshot (OCR)</h2>
                    <button class="ocrModalClose" onClick={onClose}>✕</button>
                </div>

                {step === 'upload' ? (
                    <div class="ocrModalBody">
                        <div class="ocrSection">
                            <label class="ocrLabel">Gemini API Key</label>
                            <input
                                type="password"
                                class="ocrInput"
                                placeholder="AIza..."
                                value={apiKey}
                                onInput={(e) => setApiKey(e.currentTarget.value)}
                            />
                            <a
                                href="https://aistudio.google.com/app/apikey"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="ocrApiLink"
                            >
                                Get a free API key from Google AI Studio
                                <ExternalLink size={12} />
                            </a>
                        </div>

                        <div class="ocrSection">
                            <label class="ocrLabel">Screenshot</label>
                            <div
                                ref={dropzoneRef}
                                class={`ocrDropzone ${isDragOver ? 'dragover' : ''} ${imagePreview ? 'hasImage' : ''}`}
                                onClick={handleDropzoneClick}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                            >
                                {imagePreview ? (
                                    <img src={imagePreview} class="ocrPreview" alt="Preview" />
                                ) : (
                                    <div class="ocrDropzoneContent">
                                        <ImageIcon size={40} class="ocrDropzoneIcon" />
                                        <span>Click to select, drag & drop, or paste an image</span>
                                    </div>
                                )}
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                style="display:none"
                                onChange={handleFileChange}
                            />
                        </div>

                        {error && <div class="ocrError">{error}</div>}

                        <div class="ocrModalFooter">
                            <button class="ocrBtnSecondary" onClick={onClose}>Cancel</button>
                            <button
                                class="ocrBtnPrimary"
                                onClick={handleExtract}
                                disabled={isExtracting}
                            >
                                {isExtracting
                                    ? <><Loader2 size={14} class="ocrSpinner" /> Extracting...</>
                                    : <>Extract</>
                                }
                            </button>
                        </div>
                    </div>
                ) : (
                    <div class="ocrModalBody">
                        <div class="ocrReviewLayout">
                            <div class="ocrReviewImageSection">
                                <img src={imagePreview!} class="ocrReviewImage" alt="Screenshot" />
                            </div>
                            <div class="ocrReviewDataSection">
                                <div class="ocrReviewGrid">
                                    <div class="ocrReviewItem">
                                        <span class="ocrReviewKey">Name</span>
                                        <span class="ocrReviewValue">{ocrData?.name || '—'}</span>
                                    </div>
                                    <div class="ocrReviewItem">
                                        <span class="ocrReviewKey">Outfit</span>
                                        <span class="ocrReviewValue">{ocrData?.outfit || '—'}</span>
                                    </div>
                                    <div class="ocrReviewItem ocrReviewStats">
                                        <span class="ocrReviewKey">Stats</span>
                                        <span class="ocrReviewValue">
                                            SPD {ocrData?.speed} / STA {ocrData?.stamina} / PWR {ocrData?.power} / GUT {ocrData?.guts} / WIS {ocrData?.wisdom}
                                        </span>
                                    </div>
                                    <div class="ocrReviewItem ocrReviewEditable">
                                        <span class="ocrReviewKey">Surface</span>
                                        <AptitudeSelect
                                            a={editedAptitudes.surfaceAptitude}
                                            setA={(v) => setEditedAptitudes(a => ({ ...a, surfaceAptitude: v }))}
                                            tabindex={-1}
                                        />
                                    </div>
                                    <div class="ocrReviewItem ocrReviewEditable">
                                        <span class="ocrReviewKey">Distance</span>
                                        <AptitudeSelect
                                            a={editedAptitudes.distanceAptitude}
                                            setA={(v) => setEditedAptitudes(a => ({ ...a, distanceAptitude: v }))}
                                            tabindex={-1}
                                        />
                                    </div>
                                    <div class="ocrReviewItem ocrReviewEditable">
                                        <span class="ocrReviewKey">Style Apt.</span>
                                        <AptitudeSelect
                                            a={editedAptitudes.strategyAptitude}
                                            setA={(v) => setEditedAptitudes(a => ({ ...a, strategyAptitude: v }))}
                                            tabindex={-1}
                                        />
                                    </div>
                                    <div class="ocrReviewItem ocrReviewEditable">
                                        <span class="ocrReviewKey">Strategy</span>
                                        <StrategySelect
                                            s={editedStrategy}
                                            setS={setEditedStrategy}
                                            tabindex={-1}
                                        />
                                    </div>
                                    <div class="ocrReviewItem ocrReviewSkills">
                                        <span class="ocrReviewKey">Skills</span>
                                        <div class="ocrSkillList">
                                            {(ocrData?.skills || []).map((s, i) => (
                                                <span key={i} class="ocrSkillTag">{s}</span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="ocrModalFooter">
                            <button class="ocrBtnSecondary" onClick={() => setStep('upload')}>
                                <ArrowLeft size={14} /> Back
                            </button>
                            <button class="ocrBtnPrimary" onClick={handleConfirm}>
                                <Check size={14} /> Confirm & Load
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
