import type { FilterCondition, FilterGroup, FilterNode, FilterOperator, FilterScalar } from '../../shared/model';
import { addChild, emptyGroup, mapNode, newCondition, NO_VALUE, OPERATOR_LABELS, operatorsFor, parseValue } from '../lib/filters';
import type { ColumnCategory } from '../lib/util';
import { Icon, IconButton } from './Icon';

export interface FilterField {
  /** Table alias in the query builder; undefined in the single-table browser. */
  source?: string;
  column: string;
  category: ColumnCategory;
  label: string;
}

interface Props {
  value: FilterGroup;
  onChange: (g: FilterGroup) => void;
  fields: FilterField[];
  maxDepth?: number;
}

const fieldKey = (f: { source?: string; column: string }) => `${f.source ?? ''}\u0001${f.column}`;

export function FilterBuilder({ value, onChange, fields, maxDepth = 4 }: Props) {
  return (
    <div className="filter-builder">
      <GroupView group={value} root fields={fields} depth={0} maxDepth={maxDepth} onChange={(id, fn) => onChange(mapNode(value, id, fn))} onAdd={(parent, child) => onChange(addChild(value, parent, child))} />
    </div>
  );
}

type Mutate = (id: string, fn: (n: FilterNode) => FilterNode | null) => void;

function GroupView({
  group,
  root,
  fields,
  depth,
  maxDepth,
  onChange,
  onAdd,
}: {
  group: FilterGroup;
  root?: boolean;
  fields: FilterField[];
  depth: number;
  maxDepth: number;
  onChange: Mutate;
  onAdd: (parentId: string, child: FilterNode) => void;
}) {
  const first = fields[0];
  return (
    <div className={`filter-group depth-${depth}`} role="group" aria-label={`${group.combinator.toUpperCase()} group`}>
      <div className="filter-group-head">
        <div className="segmented" role="radiogroup" aria-label="Combine conditions with">
          {(['and', 'or'] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={group.combinator === c}
              className={group.combinator === c ? 'on' : ''}
              onClick={() => onChange(group.id, (n) => ({ ...(n as FilterGroup), combinator: c }))}
            >
              {c.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="muted small">{group.combinator === 'and' ? 'all conditions must match' : 'any condition may match'}</span>
        <span className="spacer" />
        <button type="button" className="btn small ghost" disabled={!first} onClick={() => first && onAdd(group.id, newCondition(first.column, first.category, first.source))}>
          <Icon name="plus" /> Condition
        </button>
        {depth < maxDepth ? (
          <button type="button" className="btn small ghost" onClick={() => onAdd(group.id, emptyGroup(group.combinator === 'and' ? 'or' : 'and'))}>
            <Icon name="plus" /> Group
          </button>
        ) : null}
        {!root ? <IconButton icon="x" label="Remove group" onClick={() => onChange(group.id, () => null)} /> : null}
      </div>
      {group.children.length === 0 ? <div className="muted small pad-s">{root ? 'No filters. Add a condition to narrow the rows.' : 'Empty group'}</div> : null}
      {group.children.map((child) =>
        child.kind === 'group' ? (
          <GroupView key={child.id} group={child} fields={fields} depth={depth + 1} maxDepth={maxDepth} onChange={onChange} onAdd={onAdd} />
        ) : (
          <ConditionRow key={child.id} cond={child} fields={fields} onChange={onChange} />
        ),
      )}
    </div>
  );
}

function ConditionRow({ cond, fields, onChange }: { cond: FilterCondition; fields: FilterField[]; onChange: Mutate }) {
  const field = fields.find((f) => fieldKey(f) === fieldKey(cond)) ?? fields[0];
  const category = field?.category ?? 'other';
  const ops = operatorsFor(category);
  const update = (patch: Partial<FilterCondition>) => onChange(cond.id, (n) => ({ ...(n as FilterCondition), ...patch }));
  const valueStr = (v: FilterScalar | undefined) => (v === undefined || v === null ? '' : String(v));
  const placeholder = category === 'date' ? 'YYYY-MM-DD[ HH:MM:SS]' : category === 'number' ? 'number' : 'value';

  return (
    <div className="filter-row">
      <select
        aria-label="Column"
        value={field ? fieldKey(field) : ''}
        onChange={(e) => {
          const f = fields.find((x) => fieldKey(x) === e.target.value);
          if (!f) return;
          const next = newCondition(f.column, f.category, f.source);
          update({ column: f.column, source: f.source, operator: operatorsFor(f.category).includes(cond.operator) ? cond.operator : next.operator });
        }}
      >
        {fields.map((f) => (
          <option key={fieldKey(f)} value={fieldKey(f)}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Operator"
        value={cond.operator}
        onChange={(e) => {
          const op = e.target.value as FilterOperator;
          update({ operator: op, value: NO_VALUE.has(op) ? undefined : (cond.value ?? ''), values: op === 'in' || op === 'not_in' ? (cond.values ?? []) : undefined });
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>
      {NO_VALUE.has(cond.operator) ? null : cond.operator === 'in' || cond.operator === 'not_in' ? (
        <input
          aria-label="Values (comma separated)"
          placeholder="a, b, c"
          defaultValue={(cond.values ?? []).join(', ')}
          onChange={(e) =>
            update({
              values: e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter((v) => v !== '')
                .map((v) => parseValue(v, category)),
            })
          }
        />
      ) : cond.operator === 'between' ? (
        <>
          <input aria-label="From" placeholder={placeholder} value={valueStr(cond.value)} onChange={(e) => update({ value: parseValue(e.target.value, category) })} />
          <span className="muted">and</span>
          <input aria-label="To" placeholder={placeholder} value={valueStr(cond.value2)} onChange={(e) => update({ value2: parseValue(e.target.value, category) })} />
        </>
      ) : (
        <input aria-label="Value" placeholder={placeholder} value={valueStr(cond.value)} onChange={(e) => update({ value: parseValue(e.target.value, category) })} />
      )}
      <IconButton icon="x" label="Remove condition" onClick={() => onChange(cond.id, () => null)} />
    </div>
  );
}
