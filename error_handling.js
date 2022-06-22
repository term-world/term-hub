// Set up error handling messages and store it in google cloud

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, prettyPrint } = format;


const options = {
    file: {
        level: 'info',
        filename: 'err_list.log',
        handleExceptions: true,
        json: true,
        colorize: true,
    },
    console: {
        level: 'debug',
        handleExceptions: true,
        json: false,
        colorize: true,
    },
};

const err_logger = createLogger(
    {   
        format: combine(
            timestamp(),
            prettyPrint()
          ),
        defaultMeta: { service: 'user-service' },
        transports: [
            new transports.Console(options.console),
            new transports.File(
                options.file),
        ]
    }
);

/**
 * Attempts to connect to throw error message once error occurs
 * @function err_message
 * @param {String}    e_mess  Message to throw when error occurs
 * @param {String}    user  User name, default to 'all' if error occur to all user
 */

const err_message = (e_mess, user) => {
    err_logger.info({
        message: `[${e_mess}]` + ' happened to ' + `[${user}]`
    });
}

module.exports = { err_message };