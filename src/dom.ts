type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "className">> & {
  class?: string;
};

/** Create an element with properties and children: `h("button", { onclick }, "Save")`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  Object.assign(el, rest);
  if (className) el.className = className;
  el.append(...children);
  return el;
}
