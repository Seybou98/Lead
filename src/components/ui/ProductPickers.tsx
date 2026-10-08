import { ChipMultiSelect, type ChipOption } from './ChipMultiSelect';
import { inputClass } from './Modal';
import { ALL_PRODUCTS, type ProductCategory } from '../../domain/products/catalog';

const hintOf = (c: ProductCategory) => `${c.count} article${c.count > 1 ? 's' : ''}`;

/** Choix d'une famille de produit du catalogue. Une valeur déjà enregistrée mais absente du catalogue reste visible. */
export function ProductSelect({
  value,
  onChange,
  categories,
  emptyLabel = 'Aucun produit',
  ariaLabel = 'Produit',
}: {
  value: string;
  onChange: (v: string) => void;
  categories: readonly ProductCategory[];
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const known = categories.some((c) => c.code === value);
  return (
    <select aria-label={ariaLabel} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {value && !known && <option value={value}>{value} (hors catalogue)</option>}
      {categories.map((c) => (
        <option key={c.code} value={c.code}>{c.code} — {hintOf(c)}</option>
      ))}
    </select>
  );
}

/** Choix de plusieurs familles du catalogue, avec « Tous les produits ». */
export function ProductChips({
  selected,
  onChange,
  categories,
  ariaLabel = 'Produits',
  allowAll = true,
}: {
  selected: readonly string[];
  onChange: (v: string[]) => void;
  categories: readonly ProductCategory[];
  ariaLabel?: string;
  allowAll?: boolean;
}) {
  const options: ChipOption[] = [
    ...(allowAll ? [{ id: ALL_PRODUCTS, label: 'Tous les produits' }] : []),
    ...categories.map((c) => ({ id: c.code, label: c.code, hint: hintOf(c) })),
  ];
  return <ChipMultiSelect ariaLabel={ariaLabel} options={options} selected={selected} onChange={onChange} placeholder="Choisir dans le catalogue…" />;
}
