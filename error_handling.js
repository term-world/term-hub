// Set up error handling messages and store it in google cloud

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, prettyPrint } = format;

// Set up format options for log's console and stored file 
const options = {
    file: {
        level: 'error',
        filename: 'err_list.log',
        handleExceptions: true,
        json: true,
        colorize: true,
        process: false,
        trace: false,
    },
    console: {
        level: 'debug',
        handleExceptions: true,
        json: false,
        colorize: true,
    },
};

// Set up logger with custume format and transport
const err_logger = createLogger(
    {   
        format: combine(
            timestamp(),
            prettyPrint()
          ),
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
 */

const err_message = (e_mess) => {
    err_logger.info({
        message: `[${e_mess}]`,
    });
    err_logger.error({
        message: `[${e_mess}]`,
    });
}

module.exports = { err_message };