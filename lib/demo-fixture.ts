import type {
  MinutesReport,
  SpeakerProfile,
  TranscriptSegment,
} from "./types";
import { makeSpeaker } from "./types";

/** Demo data for the editor preview (?demo=1). Lets users see the editor
 *  without uploading a real recording, and is what /editor renders if you
 *  arrive there cold. */

export const DEMO_SPEAKERS: SpeakerProfile[] = [
  makeSpeaker("spk-0", 0, "陳怡君 · 產品"),
  makeSpeaker("spk-1", 1, "林志遠 · 工程"),
  makeSpeaker("spk-2", 2, "Naomi · 設計"),
];

export const DEMO_SEGMENTS: TranscriptSegment[] = [
  {
    id: "d-0",
    start: 0.4,
    end: 6.2,
    text: "好，今天主要要把下一個 Sprint 的範圍敲定，然後決定要不要把客戶端的離線快取拉進來。",
    speakerId: "spk-0",
  },
  {
    id: "d-1",
    start: 6.6,
    end: 13.5,
    text: "我覺得快取要做，但是不要做太大。先把目錄頁、商品詳情頁兩個路由做掉，登入後的個人化先不動。",
    speakerId: "spk-1",
  },
  {
    id: "d-2",
    start: 14.0,
    end: 20.1,
    text: "對，個人化頁面快取要碰權限，會踩到資料外洩的風險。設計上我們也比較傾向先做匿名路由。",
    speakerId: "spk-2",
  },
  {
    id: "d-3",
    start: 20.6,
    end: 28.0,
    text: "OK，那我們今天的結論就是：Sprint 22 把離線快取 v1 上線，目錄、詳情兩條路由；個人化推到 Sprint 23 再評估。",
    speakerId: "spk-0",
  },
  {
    id: "d-4",
    start: 28.5,
    end: 34.7,
    text: "我這邊負責 service worker 跟快取策略，預計禮拜五前可以發出 PR。",
    speakerId: "spk-1",
  },
  {
    id: "d-5",
    start: 35.2,
    end: 41.0,
    text: "我來把離線狀態的提示元件補上去，包含一個小的離線徽章跟資料過期提示。",
    speakerId: "spk-2",
  },
  {
    id: "d-6",
    start: 41.6,
    end: 47.4,
    text: "另外想跟大家確認，下個禮拜三我們有對外的客戶 demo，是不是要把離線快取也排進去？",
    speakerId: "spk-0",
  },
  {
    id: "d-7",
    start: 47.9,
    end: 53.6,
    text: "可以排，但如果到時候 PR 還沒合，就先 demo 線上版本，不要冒險。",
    speakerId: "spk-1",
  },
  {
    id: "d-8",
    start: 54.0,
    end: 60.0,
    text: "同意。Demo 之前我會先跑一輪走查，確認所有流程都順。今天就先到這裡。",
    speakerId: "spk-0",
  },
];

export const DEMO_REPORT: MinutesReport = {
  title: "Sprint 22 範圍確認與離線快取決策會議",
  summary:
    "本次會議聚焦於 Sprint 22 的範圍劃定，決定將離線快取 v1 限縮於目錄與商品詳情兩條路由，個人化頁面延後至 Sprint 23 評估，並協調下週客戶 demo 的呈現方案。",
  conclusions: [
    "Sprint 22 範圍鎖定為離線快取 v1：目錄頁、商品詳情頁。",
    "個人化頁面快取因涉及權限與資料外洩風險，延後到 Sprint 23 再評估。",
    "下週三客戶 demo 以線上版本為主，若 PR 合併趕得上再切換到離線版。",
  ],
  topics: [
    {
      heading: "Sprint 22 範圍",
      points: [
        "離線快取只做目錄與商品詳情兩條路由。",
        "個人化頁面因隱私風險暫不納入。",
        "設計傾向先處理匿名路由再評估登入後體驗。",
      ],
    },
    {
      heading: "技術分工",
      points: [
        "志遠負責 service worker 與快取策略，週五前提 PR。",
        "Naomi 補上離線徽章與資料過期提示元件。",
        "怡君安排走查確認整體流程順暢。",
      ],
    },
    {
      heading: "客戶 Demo",
      points: [
        "下週三的對外 demo 預設仍以線上版本呈現。",
        "若 PR 順利合併再臨時加上離線快取展示。",
      ],
    },
  ],
  openQuestions: [
    "離線快取要不要進下週三的客戶 demo，取決於 PR 能否在期限前合併，demo 前一日走查時才會確認。",
  ],
  actions: [
    {
      task: "提交離線快取 v1 PR（service worker + 兩條路由策略）",
      owner: "林志遠",
      due: "本週五",
    },
    {
      task: "完成離線徽章與資料過期提示元件設計與實作",
      owner: "Naomi",
      due: "下週一",
    },
    {
      task: "於客戶 demo 前完成一次完整流程走查",
      owner: "陳怡君",
      due: "下週三 demo 前一日",
    },
    {
      task: "Sprint 23 規劃會議排入「個人化頁面快取評估」議題",
      owner: "陳怡君",
      due: "Sprint 22 收尾",
    },
  ],
};
