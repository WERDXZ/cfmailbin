import { useLayoutEffect, useState } from "preact/hooks";

const parse = (text: string) =>
  text.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
const equal = (a: string[], b: string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Keep unfinished separators in the input while exposing normalized tags. */
export function TagsInput(
  { value, onChange, placeholder, maxLength }: {
    value: string[];
    onChange: (tags: string[]) => void;
    placeholder?: string;
    maxLength?: number;
  },
) {
  const [text, setText] = useState(value.join(", "));
  useLayoutEffect(() => {
    setText((current) =>
      equal(parse(current), value) ? current : value.join(", ")
    );
  }, [value]);
  return (
    <input
      value={text}
      placeholder={placeholder}
      maxLength={maxLength}
      onInput={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        onChange(parse(next));
      }}
    />
  );
}
