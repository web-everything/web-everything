// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { formatCardSquashMarker, parseCardSquashMarkers, squashPatchHash, postCardSquashMarker } from '../card-squash-marker.mjs';
const proof = { oldHead: 'a'.repeat(40), newHead: 'b'.repeat(40), patchHash: squashPatchHash('+card\n') };
const trusted = { body: formatCardSquashMarker(proof), author: { login: 'chalbert' } };
it('round trips only trusted proofs', () => {
  expect(trusted.body.startsWith('🔁 conveyor — card squash proof')).toBe(true);
  expect(parseCardSquashMarkers([trusted])).toEqual([proof]);
  expect(parseCardSquashMarkers([{ ...trusted, author: { login: 'outsider' } }, trusted.body])).toEqual([]);
});
it('dedupes by new head and swallows failed posts', () => {
  const postComment = vi.fn();
  const result = { action: 'rebased', proof };
  expect(postCardSquashMarker({ result, comments: [trusted], postComment })).toBe(false);
  expect(postComment).not.toHaveBeenCalled();
  expect(postCardSquashMarker({ result, comments: [], postComment })).toBe(true);
  expect(postComment).toHaveBeenCalledWith(trusted.body);
  expect(postCardSquashMarker({ result, comments: [], postComment: () => { throw Error('offline'); } })).toBe(false);
  expect(postCardSquashMarker({ result, readComments: () => { throw Error('offline'); }, postComment })).toBe(false);
  expect(postCardSquashMarker({ result: { ...result, action: 'dry-run' }, comments: [], postComment })).toBe(false);
  expect(postComment).toHaveBeenCalledTimes(1);
});
