// 终端增强功能使用示例

import { Terminal } from '../components/terminal';

// 基础使用 - 使用默认配置
function BasicExample() {
  return (
    <Terminal
      sessionId="session-1"
      sessionName="My Server"
      host="example.com"
      username="admin"
    />
  );
}

// 高性能配置 - WebGL 渲染 + 流控制
function HighPerformanceExample() {
  return (
    <Terminal
      sessionId="session-2"
      sessionName="Production Server"
      host="prod.example.com"
      username="admin"
      config={{
        rendererType: 'webgl',
        enableFlowControl: true,
        enableUnicode: true,
        enableSixel: false,
        flowControl: {
          limit: 200000,
          highWater: 10,
          lowWater: 4,
        },
      }}
    />
  );
}

// 兼容性配置 - Canvas 渲染器
function CompatibilityExample() {
  return (
    <Terminal
      sessionId="session-3"
      sessionName="Legacy Server"
      host="legacy.example.com"
      username="root"
      config={{
        rendererType: 'canvas',
        enableFlowControl: true,
        enableUnicode: true,
      }}
    />
  );
}

// 图像支持配置 - 启用 Sixel
function ImageSupportExample() {
  return (
    <Terminal
      sessionId="session-4"
      sessionName="Graphics Server"
      host="graphics.example.com"
      username="designer"
      config={{
        rendererType: 'webgl',
        enableFlowControl: true,
        enableUnicode: true,
        enableSixel: true,  // 启用 Sixel 图像支持
      }}
    />
  );
}

// 自定义流控制 - 适用于大量日志输出
function LogServerExample() {
  return (
    <Terminal
      sessionId="session-5"
      sessionName="Log Server"
      host="logs.example.com"
      username="logger"
      config={{
        rendererType: 'webgl',
        enableFlowControl: true,
        enableUnicode: true,
        flowControl: {
          limit: 500000,     // 更高的限制适合大量输出
          highWater: 20,     // 更高的高水位
          lowWater: 8,       // 更高的低水位
        },
      }}
    />
  );
}

export {
  BasicExample,
  HighPerformanceExample,
  CompatibilityExample,
  ImageSupportExample,
  LogServerExample,
};
