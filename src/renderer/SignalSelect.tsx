import * as Select from '@radix-ui/react-select';
import type { SignalAppearance } from '../shared/types';

export interface SignalSelectOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

interface SignalSelectProps<Value extends string> {
  label: string;
  value: Value;
  options: readonly SignalSelectOption<Value>[];
  appearance: SignalAppearance;
  onChange: (value: Value) => void;
}

/** Shared select-only combobox; Radix owns keyboard, focus and collision handling. */
export default function SignalSelect<Value extends string>({
  label, value, options, appearance, onChange,
}: SignalSelectProps<Value>) {
  return (
    <Select.Root value={value} onValueChange={next => {
      if (options.some(option => option.value === next)) onChange(next as Value);
    }}>
      <Select.Trigger className="signal-select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon className="signal-select-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
            strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className={'signal-select-content scene-' + appearance}
          position="popper" side="bottom" align="start" sideOffset={7}
          collisionPadding={10} avoidCollisions
          aria-label={label}>
          <Select.ScrollUpButton className="signal-select-scroll-button" aria-label="向上滚动">
            <span aria-hidden="true">⌃</span>
          </Select.ScrollUpButton>
          <Select.Viewport className="signal-select-viewport">
            {options.map(option => (
              <Select.Item key={option.value} value={option.value}
                disabled={option.disabled} className="signal-select-option">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="signal-select-option-check">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="m5 12 4 4L19 6"/>
                  </svg>
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="signal-select-scroll-button" aria-label="向下滚动">
            <span aria-hidden="true">⌄</span>
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
