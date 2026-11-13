/** React and native keyboard events, including older IMEs that only report keyCode 229. */
export function isImeComposing(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229 || event.keyCode === 229;
}
