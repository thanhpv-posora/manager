import axios from 'axios';

function getApiBase(){
  const envUrl = import.meta.env.VITE_API_URL;
  if (typeof window === 'undefined') return envUrl || '/api';
  const currentHost = window.location.hostname;
  const isCurrentLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(currentHost);
  if (envUrl) {
    try {
      const u = new URL(envUrl, window.location.origin);
      const envIsLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(u.hostname);
      if (!isCurrentLocal && envIsLocal) return `${window.location.origin}/api`;
      return envUrl;
    } catch (_) {
      return envUrl;
    }
  }
  return `${window.location.origin}/api`;
}

const api=axios.create({baseURL:getApiBase(),timeout:45000});
api.interceptors.request.use(c=>{const t=localStorage.getItem('token');if(t)c.headers.Authorization=`Bearer ${t}`;return c});
export default api;
