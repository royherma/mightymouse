import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Trash2, ChevronDown } from 'lucide-react';
import { QuickAction, AppMode } from '../../../shared/types';
import { CONFIG } from '../../../shared/config';
import SkillBodyEditor from './SkillBodyEditor';
import EmojiPicker from './EmojiPicker';
import { Modal } from './Modal';
import { Button } from './Button';

interface Props {
  onClose: () => void;
  onSaved: (actions: QuickAction[]) => void;
}

type DraftAction = Omit<QuickAction, 'key'> & { key: string; _isNew?: boolean };

const MODES: AppMode[] = ['rewrite', 'ask', 'act'];
const L = CONFIG.UI_LABELS;
const DEFAULT_ICON = L.SHORTCUT_DEFAULT_ICON;

function makeKey(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function blankDraft(): DraftAction {
  // Seed a REAL default icon (not '') so the field shows it and the pill matches.
  return { key: makeKey(), label: '', icon: DEFAULT_ICON, mode: 'ask', instruction: '', body: '', _isNew: true };
}

export default function QuickActionEditor({ onClose, onSaved }: Props): React.ReactElement {
  const [drafts, setDrafts] = useState<DraftAction[]>([]);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  // Which row's emoji picker is open (index), or null. Only one at a time.
  const [pickerIdx, setPickerIdx] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load existing actions on mount. If there are none, jump straight to a
  // blank add form — the empty-state + manual "add skill" click is a dead step.
  useEffect(() => {
    window.api.actionsLoad().then((actions) => {
      const existing = actions as DraftAction[];
      if (existing.length === 0) {
        setDrafts([blankDraft()]);
        setEditIdx(0);
      } else {
        setDrafts(existing);
      }
      setLoaded(true);
    }).catch(() => {
      setLoaded(true);
    });
  }, []);

  const addSkill = () => {
    setDrafts(prev => {
      const next = [...prev, blankDraft()];
      setEditIdx(next.length - 1);
      return next;
    });
    // Scroll the freshly-added row into view once it renders.
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    });
  };

  const removeSkill = (idx: number) => {
    const next = drafts.filter((_, i) => i !== idx);
    setDrafts(next);
    if (editIdx === idx) setEditIdx(null);
    else if (editIdx !== null && editIdx > idx) setEditIdx(editIdx - 1);
  };

  const updateDraft = (idx: number, patch: Partial<DraftAction>) => {
    setDrafts(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
  };

  const handleSave = async () => {
    const bad = drafts.find(d => !d.label.trim());
    if (bad) {
      setError(L.SKILL_EDITOR_NEEDS_NAME);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const clean: QuickAction[] = drafts.map(({ _isNew, ...rest }) => ({
        ...rest,
        // If body is provided but instruction is empty, use body as instruction.
        instruction: rest.instruction.trim() || rest.body?.trim() || '',
      }));
      const saved = await window.api.actionsSave(clean);
      onSaved(saved);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Save failed');
      setSaving(false);
    }
  };

  return (
    <Modal label={L.SKILL_EDITOR_TITLE} onClose={onClose} backdropClassName="skill-modal-backdrop" className="skill-modal">
        <header className="skill-modal-head">
          <div className="skill-modal-titles">
            <span className="skill-modal-title">{L.SKILL_EDITOR_TITLE}</span>
            <span className="skill-modal-subtitle">{L.SKILL_EDITOR_SUBTITLE}</span>
          </div>
          <Button variant="bare" className="skill-modal-close" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2} />
          </Button>
        </header>

        {!loaded ? (
          <div className="skill-modal-loading">Loading…</div>
        ) : (
          <>
            <div className="skill-modal-list" ref={listRef}>
              {drafts.length === 0 && (
                <div className="skill-modal-empty">{L.SKILL_EDITOR_EMPTY}</div>
              )}
              {drafts.map((d, idx) => {
                const expanded = editIdx === idx;
                return (
                  <div key={d.key} className={`skill-row ${expanded ? 'expanded' : ''}`}>
                    <Button
                      variant="bare"
                      className="skill-row-head"
                      onClick={() => setEditIdx(expanded ? null : idx)}
                    >
                      <span className="skill-row-icon">{d.icon || DEFAULT_ICON}</span>
                      <span className="skill-row-label">
                        {d.label || <em className="skill-row-unnamed">{L.SKILL_EDITOR_UNNAMED}</em>}
                      </span>
                      <span className={`skill-row-mode ${d.mode}`}>{d.mode}</span>
                      <ChevronDown className="skill-row-chevron" size={15} strokeWidth={2.25} />
                      <span
                        className="skill-row-delete"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); removeSkill(idx); }}
                        title={L.SKILL_REMOVE_TOOLTIP}
                        aria-label={L.SKILL_REMOVE_TOOLTIP}
                      >
                        <Trash2 size={15} strokeWidth={2} />
                      </span>
                    </Button>

                    {expanded && (
                      <div className="skill-row-form">
                        <div className="skill-form-grid">
                          <div className="skill-field skill-field-icon">
                            <label className="skill-field-label">{L.SKILL_FIELD_ICON}</label>
                            <div className="skill-icon-pick">
                              <Button
                                variant="bare"
                                className="skill-input skill-icon-btn"
                                onClick={() => setPickerIdx(pickerIdx === idx ? null : idx)}
                                title={L.SHORTCUT_ICON_PICK_HINT}
                                aria-label={L.SHORTCUT_ICON_PICK_HINT}
                              >
                                {d.icon || DEFAULT_ICON}
                              </Button>
                              {pickerIdx === idx && (
                                <EmojiPicker
                                  value={d.icon || DEFAULT_ICON}
                                  onPick={(emoji) => updateDraft(idx, { icon: emoji })}
                                  onClose={() => setPickerIdx(null)}
                                />
                              )}
                            </div>
                          </div>
                          <div className="skill-field skill-field-name">
                            <label className="skill-field-label">{L.SKILL_FIELD_NAME}</label>
                            <input
                              className="skill-input"
                              value={d.label}
                              onChange={e => updateDraft(idx, { label: e.target.value })}
                              placeholder={L.SKILL_NAME_PLACEHOLDER}
                              maxLength={32}
                            />
                          </div>
                          <div className="skill-field skill-field-mode">
                            <label className="skill-field-label">{L.SKILL_FIELD_MODE}</label>
                            <select
                              className="skill-select"
                              value={d.mode}
                              onChange={e => updateDraft(idx, { mode: e.target.value as AppMode })}
                            >
                              {MODES.map(m => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="skill-field">
                          <label className="skill-field-label">
                            {L.SKILL_FIELD_BODY}
                            <span className="skill-field-hint">{L.SKILL_FIELD_BODY_HINT}</span>
                          </label>
                          <SkillBodyEditor
                            value={d.body ?? d.instruction}
                            onChange={v => updateDraft(idx, { body: v, instruction: v })}
                            placeholder={L.SKILL_BODY_PLACEHOLDER}
                            rows={4}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <footer className="skill-modal-foot">
              <Button variant="ghost" onClick={addSkill}>
                <Plus size={15} strokeWidth={2.5} />
                {L.SKILL_EDITOR_ADD}
              </Button>
              <div className="skill-foot-right">
                {error && <span className="skill-modal-error">{error}</span>}
                <Button
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? L.SKILL_EDITOR_SAVING : L.SKILL_EDITOR_SAVE}
                </Button>
              </div>
            </footer>
          </>
        )}
    </Modal>
  );
}
