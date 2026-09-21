/** Where the app points people when they want to reach a human. */
export const REPO_URL = 'https://github.com/scottjahn/ChessTrainer';
export const CONTACT_EMAIL = 'scott.jahn@gmail.com';

/** A prefilled "new issue" form on the repo. */
export function newIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body });
  return `${REPO_URL}/issues/new?${params}`;
}

/**
 * A shareable link to one puzzle. The app is a HashRouter served from a
 * relative base, so the path in front of the hash has to be kept as-is.
 */
export function puzzleUrl(id: number): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/puzzle/${id}`;
}
