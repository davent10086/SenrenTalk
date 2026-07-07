import type { GroupChatRoomMode, GroupChatSkipReason } from "../../common/types";

export interface ChatStreamState {
  drafts: Record<string, string>;
  agentStatus: Record<string, string>;
  activeRoleId: string | null;
  isStreaming: boolean;
  error: string | null;
  notice: string | null;
  currentRound: number;
  plannedSpeakers: string[];
  skippedRoles: Array<{ roleId: string; reason: GroupChatSkipReason; message: string }>;
  finishedReason: string | null;
  roomMode: GroupChatRoomMode | null;
  targetRoleId: string | null;
}

type ChatStreamAction =
  | { type: "prepare" }
  | { type: "finish" }
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "notice"; message: string }
  | { type: "round_started"; round: number; roomMode: GroupChatRoomMode; targetRoleId: string | null }
  | { type: "round_plan"; round: number; plannedSpeakers: string[]; roomMode: GroupChatRoomMode; targetRoleId: string | null }
  | { type: "role_skipped"; roleId: string; reason: GroupChatSkipReason; message: string }
  | { type: "room_finished"; reason: string }
  | { type: "status"; roleId: string; message: string; activeRoleId: string | null }
  | { type: "token"; roleId: string; token: string; activeRoleId: string | null }
  | { type: "complete"; roleId: string };

export const initialChatStreamState: ChatStreamState = {
  drafts: {},
  agentStatus: {},
  activeRoleId: null,
  isStreaming: false,
  error: null,
  notice: null,
  currentRound: 0,
  plannedSpeakers: [],
  skippedRoles: [],
  finishedReason: null,
  roomMode: null,
  targetRoleId: null,
};

export function reduceChatStreamState(
  state: ChatStreamState,
  action: ChatStreamAction,
): ChatStreamState {
  switch (action.type) {
    case "prepare":
      return {
        ...initialChatStreamState,
        isStreaming: true,
      };
    case "finish":
      return {
        ...state,
        isStreaming: false,
        activeRoleId: null,
      };
    case "reset":
      return initialChatStreamState;
    case "error":
      return {
        ...initialChatStreamState,
        error: action.message,
      };
    case "notice":
      return {
        ...initialChatStreamState,
        notice: action.message,
      };
    case "round_started":
      return {
        ...state,
        currentRound: action.round,
        roomMode: action.roomMode,
        targetRoleId: action.targetRoleId,
        finishedReason: null,
        skippedRoles: [],
      };
    case "round_plan":
      return {
        ...state,
        currentRound: action.round,
        plannedSpeakers: action.plannedSpeakers,
        roomMode: action.roomMode,
        targetRoleId: action.targetRoleId,
      };
    case "role_skipped":
      return {
        ...state,
        skippedRoles: [...state.skippedRoles, action],
      };
    case "room_finished":
      return {
        ...state,
        finishedReason: action.reason,
      };
    case "status":
      return {
        ...state,
        activeRoleId: action.activeRoleId,
        agentStatus: {
          ...state.agentStatus,
          [action.roleId]: action.message,
        },
        drafts: state.drafts[action.roleId] !== undefined
          ? state.drafts
          : { ...state.drafts, [action.roleId]: "" },
      };
    case "token":
      return {
        ...state,
        activeRoleId: action.activeRoleId,
        drafts: {
          ...state.drafts,
          [action.roleId]: `${state.drafts[action.roleId] ?? ""}${action.token}`,
        },
      };
    case "complete": {
      const nextDrafts = { ...state.drafts };
      delete nextDrafts[action.roleId];

      const nextAgentStatus = { ...state.agentStatus };
      delete nextAgentStatus[action.roleId];

      return {
        ...state,
        drafts: nextDrafts,
        agentStatus: nextAgentStatus,
      };
    }
    default:
      return state;
  }
}
