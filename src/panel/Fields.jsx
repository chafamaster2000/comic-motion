import React, { useEffect, useState } from 'react';
import { EASES } from '../player/ease.js';

export function Num({ value, onChange, min, max, step = 0.01, suffix }) {
  const [txt, setTxt] = useState(value ?? '');
  useEffect(() => setTxt(value ?? ''), [value]);
  const commit = (v) => {
    const n = parseFloat(v);
    if (!Number.isNaN(n)) onChange(n);
  };
  return (
    <span className="num">
      {min != null && max != null && <input type="range" min={min} max={max} step={step} value={value ?? min} onChange={(e) => onChange(parseFloat(e.target.value))} />}
      <input type="number" step={step} value={txt} onChange={(e) => setTxt(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit(e.target.value)} />
      {suffix && <span className="dim">{suffix}</span>}
    </span>
  );
}

export function EaseSelect({ value, onChange }) {
  const v = typeof value === 'string' ? value : value ? JSON.stringify(value) : '';
  return (
    <select value={v} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">(por defecto)</option>
      {EASES.map((x) => (
        <option key={x} value={x}>
          {x}
        </option>
      ))}
      {EASES.includes(v) || !v ? null : <option value={v}>{v}</option>}
    </select>
  );
}

export function JsonField({ value, onChange, rows = 3 }) {
  const [txt, setTxt] = useState(() => (value == null ? '' : JSON.stringify(value)));
  const [bad, setBad] = useState(false);
  useEffect(() => setTxt(value == null ? '' : JSON.stringify(value)), [JSON.stringify(value)]);
  return (
    <textarea
      className={'json ' + (bad ? 'bad' : '')}
      rows={rows}
      value={txt}
      spellCheck={false}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        if (!txt.trim()) {
          setBad(false);
          return onChange(null);
        }
        try {
          onChange(JSON.parse(txt));
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}

function MotionField({ value, onChange, options }) {
  const v = value || { preset: 'none' };
  return (
    <span className="motion-field">
      <select value={v.preset} onChange={(e) => onChange({ ...v, preset: e.target.value })}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <Num value={v.duration ?? 0.4} step={0.05} onChange={(d) => onChange({ ...v, duration: d })} suffix="s" />
      <EaseSelect value={v.ease} onChange={(ease) => onChange({ ...v, ease })} />
    </span>
  );
}

function FiltersField({ value, onChange, filters }) {
  const list = value || [];
  return (
    <div className="filters">
      {list.map((f, i) => {
        const def = filters.find((d) => d.id === f.preset);
        return (
          <div className="filter" key={i}>
            <div className="filter-head">
              <b>{def?.label || f.preset}</b>
              <button className="btn tiny ghost" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                quitar
              </button>
            </div>
            {(def?.params || []).map((p) => (
              <Field key={p.key} def={p} value={f[p.key] ?? def.defaults?.[p.key]} onChange={(val) => onChange(list.map((x, j) => (j === i ? { ...x, [p.key]: val } : x)))} />
            ))}
          </div>
        );
      })}
      <select value="" onChange={(e) => e.target.value && onChange([...list, { preset: e.target.value }])}>
        <option value="">+ agregar filtro…</option>
        {filters.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Field({ def, value, onChange, ctx = {} }) {
  let input;
  switch (def.type) {
    case 'number':
      input = <Num value={value} min={def.min} max={def.max} step={def.step || (def.max != null && def.max <= 1 ? 0.01 : 1)} onChange={onChange} />;
      break;
    case 'text':
      input = <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'textarea':
      input = <textarea rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'color':
      input = (
        <span className="color">
          <input type="color" value={value || '#000000'} onChange={(e) => onChange(e.target.value)} />
          <code>{value}</code>
        </span>
      );
      break;
    case 'bool':
      input = <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case 'select':
      input = (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {def.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
      break;
    case 'ease':
      input = <EaseSelect value={value} onChange={onChange} />;
      break;
    case 'motion':
      input = <MotionField value={value} onChange={onChange} options={def.options} />;
      break;
    case 'asset':
      input = (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">(ninguno)</option>
          {Object.entries(ctx.assets || {}).map(([id, a]) => (
            <option key={id} value={id}>
              {id} · {a.type} {a.w}×{a.h}
            </option>
          ))}
        </select>
      );
      break;
    case 'filters':
      input = <FiltersField value={value} onChange={onChange} filters={ctx.filters || []} />;
      break;
    default:
      input = <JsonField value={value} onChange={onChange} />;
  }
  return (
    <label className={'field f-' + def.type}>
      <span className="field-label">{def.label || def.key}</span>
      {input}
    </label>
  );
}
