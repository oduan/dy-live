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
  WinClose: 'win:close',
  WinFullscreen: 'win:fullscreen',
  OpenExternal: 'app:openExternal',
  UpdateGetState: 'update:getState',
  UpdateInstall: 'update:install',
  ChatStart: 'chat:start',
  RecGetDir: 'rec:getDir',
  RecPickDir: 'rec:pickDir',
  RecStart: 'rec:start',
  RecWrite: 'rec:write',
  RecStop: 'rec:stop',
  RecFinalizeDone: 'rec:finalizeDone',

  // 事件（主 → 渲染）
  EvAuthChanged: 'ev:authChanged',
  EvListAutoUpdated: 'ev:listAutoUpdated',
  EvNextRefresh: 'ev:nextRefresh',
  EvRoomStatus: 'ev:roomStatus',
  EvNetBlocked: 'ev:netBlocked',
  EvNetRecovered: 'ev:netRecovered',
  EvWinMaxChanged: 'ev:winMaxChanged',
  EvUpdateState: 'ev:updateState',
  EvChatMessage: 'ev:chatMessage',
  EvRecFinalize: 'ev:recFinalize'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
