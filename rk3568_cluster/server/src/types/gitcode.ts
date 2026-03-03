export type GitCodePullRequestState = "open" | "closed" | "merged";

export type GitCodeUser = {
  id?: number | string;
  login?: string;
  name?: string;
  username?: string;
  nick_name?: string;
  nickname?: string;
  avatar_url?: string;
  html_url?: string;
  type?: string;
};

export type GitCodeLabel = {
  id: number;
  name: string;
  color?: string;
};

export type GitCodePullRequest = {
  id: number;
  number: number;
  title: string;
  state: GitCodePullRequestState;
  close_related_issue?: number | null;
  draft?: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  user?: GitCodeUser;
  labels?: GitCodeLabel[];
};

export type GitCodePullRequestComment = {
  id: number | string;
  body: string;
  html_url?: string;
  created_at: string;
  updated_at?: string;
  user?: GitCodeUser;
  author?: GitCodeUser;
  operator?: GitCodeUser;
  creator?: GitCodeUser;
  created_by?: GitCodeUser;
};

export type GitCodeApiError = {
  message?: string;
  error_message?: string;
  error?: string;
  error_code?: number;
  error_code_name?: string;
};
