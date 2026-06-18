import './index.css';
import React from'react';
import{createRoot}from'react-dom/client';
import App from'./App';
import ToastHost from'./components/ToastHost';
import AppDialogHost from'./components/AppDialogHost';

createRoot(document.getElementById('root')).render(
  <>
    <App/>
    <ToastHost/>
    <AppDialogHost/>
  </>
);
