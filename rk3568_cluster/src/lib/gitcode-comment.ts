import { type GitCodePullRequestComment, type GitCodeUser } from "@/types/gitcode";

type CommentActor = GitCodeUser | null | undefined;

function normalizeActorName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function pickActorName(actor: CommentActor): string | undefined {
  if (!actor) {
    return undefined;
  }

  return (
    normalizeActorName(actor.login)
    || normalizeActorName(actor.name)
    || normalizeActorName(actor.username)
    || normalizeActorName(actor.nick_name)
    || normalizeActorName(actor.nickname)
  );
}

export function resolveCommentActorName(
  comment: Pick<GitCodePullRequestComment, "user" | "author" | "operator" | "creator" | "created_by">,
  fallback = "unknown",
): string {
  return (
    pickActorName(comment.user)
    || pickActorName(comment.author)
    || pickActorName(comment.operator)
    || pickActorName(comment.creator)
    || pickActorName(comment.created_by)
    || fallback
  );
}

export function normalizeCommentId(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : undefined;
}

export function isSameCommentId(
  left: string | number | undefined | null,
  right: string | number | undefined | null,
): boolean {
  const leftId = normalizeCommentId(left);
  const rightId = normalizeCommentId(right);
  if (!leftId || !rightId) {
    return false;
  }
  return leftId === rightId;
}
