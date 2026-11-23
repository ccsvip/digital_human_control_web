import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#315efb',
          colorInfo: '#315efb',
          colorBgLayout: '#f4f6fa',
          colorText: '#182235',
          colorTextSecondary: '#69758a',
          colorBorder: '#e4e8f0',
          colorBorderSecondary: '#edf0f5',
          borderRadius: 10,
          fontSize: 13,
          controlHeight: 36,
          boxShadowTertiary: '0 2px 8px rgba(25, 42, 70, 0.04)',
        },
        components: {
          Button: { fontWeight: 500, primaryShadow: 'none' },
          Card: { headerFontSize: 14, bodyPadding: 20, headerPadding: 16 },
          Input: { activeShadow: '0 0 0 3px rgba(49, 94, 251, 0.1)' },
          Tag: { defaultBg: '#f5f7fa' },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
);
