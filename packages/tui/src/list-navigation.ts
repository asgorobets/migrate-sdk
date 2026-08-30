export const nextListSelection = (
  keyName: string,
  currentIndex: number,
  itemCount: number,
  pageSize = 10
): number | undefined => {
  const jump = Math.max(1, pageSize);
  let nextIndex: number;

  switch (keyName) {
    case "up":
    case "k":
      nextIndex = currentIndex - 1;
      break;
    case "down":
    case "j":
      nextIndex = currentIndex + 1;
      break;
    case "pageup":
      nextIndex = currentIndex - jump;
      break;
    case "pagedown":
      nextIndex = currentIndex + jump;
      break;
    case "home":
      nextIndex = 0;
      break;
    case "end":
      nextIndex = itemCount - 1;
      break;
    default:
      return;
  }

  return Math.min(Math.max(0, nextIndex), Math.max(0, itemCount - 1));
};
