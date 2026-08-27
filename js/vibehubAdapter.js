/* ===== vibehubAdapter.js — VibeHub 平台基础适配层 =====
 * 只负责 SDK 初始化与账号 UI；实时联机传输由 network.js 后续迁移。
 * 本地开发时不要求 VibeHub 初始化，不影响单机模式。
 */
(function (global) {
    'use strict';

    const VIBE_HOSTS = new Set(['vibeapps.lumigrav.space', 'www.vibeapps.lumigrav.space']);
    let client = null;
    let initializing = null;
    let authStop = null;

    function isVibeHubHost() {
        return !!(global.location && VIBE_HOSTS.has(global.location.hostname));
    }

    function getProjectSlug() {
        if (!isVibeHubHost()) return null;
        const parts = (global.location.pathname || '').split('/').filter(Boolean);
        return parts[0] || null;
    }

    function setStatus(text, kind) {
        const el = document.getElementById('vibehubAccountStatus');
        if (!el) return;
        el.textContent = text;
        el.dataset.status = kind || '';
    }

    function updateAuthUI(user) {
        const login = document.getElementById('vibehubLoginBtn');
        const logout = document.getElementById('vibehubLogoutBtn');
        if (user) {
            setStatus('已登录：' + (user.name || 'VibeHub 玩家'), 'logged-in');
            if (login) login.style.display = 'none';
            if (logout) logout.style.display = 'inline-block';
        } else if (isVibeHubHost()) {
            setStatus('未登录 VibeHub', 'logged-out');
            if (login) login.style.display = 'inline-block';
            if (logout) logout.style.display = 'none';
        } else {
            setStatus('本地模式', 'local');
            if (login) login.style.display = 'none';
            if (logout) logout.style.display = 'none';
        }
    }

    async function init() {
        if (!isVibeHubHost()) {
            updateAuthUI(null);
            return null;
        }
        if (!global.VibeHub || typeof global.VibeHub.init !== 'function') {
            setStatus('VibeHub SDK 未加载', 'error');
            return null;
        }
        const slug = getProjectSlug();
        if (!slug) {
            setStatus('缺少项目 slug', 'error');
            return null;
        }
        if (client) return client;
        if (initializing) return initializing;
        initializing = global.VibeHub.init({ work: slug }).then(vibe => {
            client = vibe;
            if (authStop) authStop();
            authStop = vibe.onAuthChange(updateAuthUI);
            updateAuthUI(vibe.user || null);
            return vibe;
        }).catch(error => {
            setStatus('VibeHub 初始化失败', 'error');
            console.error('[VibeHub] 初始化失败：', error);
            return null;
        }).finally(() => {
            initializing = null;
        });
        return initializing;
    }

    async function login() {
        const vibe = await init();
        if (!vibe) return null;
        try {
            return await vibe.login();
        } catch (error) {
            console.error('[VibeHub] 登录失败：', error);
            setStatus('登录失败，请重试', 'error');
            return null;
        }
    }

    function logout() {
        if (!client) return;
        client.logout();
        updateAuthUI(null);
    }

    global.TowerVibeHub = Object.freeze({
        init,
        login,
        logout,
        isPlatform: isVibeHubHost,
        getProjectSlug,
        getClient: () => client,
        isLoggedIn: () => !!(client && client.isLoggedIn())
    });

    const bind = () => {
        const loginBtn = document.getElementById('vibehubLoginBtn');
        const logoutBtn = document.getElementById('vibehubLogoutBtn');
        if (loginBtn) loginBtn.addEventListener('click', login);
        if (logoutBtn) logoutBtn.addEventListener('click', logout);
        init();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})(window);
