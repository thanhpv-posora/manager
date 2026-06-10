import './index.css';
import React from'react';
import{createRoot}from'react-dom/client';
import App from'./App';
import ToastHost from'./components/ToastHost';

createRoot(document.getElementById('root')).render(
  <>
    <App/>
    <ToastHost/>
  </>
);
