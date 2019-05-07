'use strict';

exports = module.exports = {
    CRON:  { userId: null, username: 'cron' },
    HEALTH_MONITOR: { userId: null, username: 'healthmonitor' },
    SYSADMIN: { userId: null, username: 'sysadmin' },
    TASK_MANAGER: { userId: null, username: 'taskmanager' },
    APP_TASK: { userId: null, username: 'apptask' },

    fromRequest: fromRequest
};

function fromRequest(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}
