/** IPC 通道名统一定义（主进程 / preload / 渲染进程共用） */

export const IPC = {
  // 请求
  AuthGetState: 'auth:getState',
  AuthLogout: 'auth:logout',
  ListGetCached: 'list:getCached',
  ListLoad: 'list:load',
  ListLoadMore: 'list:loadMore',
  ListRefresh: 'list:refresh',
  RoomEnter: 'room:enter',
  RoomStop: 'room:stopWatch',
  RoomCheckStatus: 'room:checkStatus',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  WinMinimize: 'win:minimize',
  WinMaximize: 'win:maximize',
  WinFullscreen: 'win:fullscreen',
  OpenExternal: 'app:openExternal',

  // 事件（主 → 渲染）
  EvAuthChanged: 'ev:authChanged',
  EvListAutoUpdated: 'ev:listAutoUpdated',
  EvNextRefresh: 'ev:nextRefresh',
  EvRoomStatus: 'ev:roomStatus',
  EvNetBlocked: 'ev:netBlocked',
  EvNetRecovered: 'ev:netRecovered'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
