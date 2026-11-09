import type { FontFamilyOption } from '@/lib/font-families';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

interface FontFamilySelectProps {
  value: string;
  options: readonly FontFamilyOption[];
  onValueChange: (value: string) => void;
  'aria-label': string;
}

export function FontFamilySelect({ value, options, onValueChange, 'aria-label': label }: FontFamilySelectProps) {
  const selected = options.find(option => option.value === value);
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue>{selected?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {!selected && <SelectItem value={value}>{value}</SelectItem>}
        {options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
