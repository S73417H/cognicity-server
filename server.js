'use strict';

// server.js - nodejs server for cognicity framework

/**
 * @file REST service querying cognicity database and responding with JSON data
 * @copyright (c) Tomas Holderness & SMART Infrastructure Facility January 2014
 * @license Released under GNU GPLv3 License (see LICENSE.txt).
 * @example
 * Usage:
 *     node server.js config.js
 */

// Node dependencies
var path = require('path');

// Modules
// Express framework module, used to handle http server interface
var express = require('express');
//Postgres 'pg' module, used for database interaction
var pg = require('pg');
// memory-cache module, used to cache responses
var cache = require('memory-cache');
// Node.js fs filesystem module
var fs = require('fs');
// topojson module, used for response format conversion
var topojson = require('topojson');
// Morgan (express logging);
var morgan = require('morgan');
// Winston logger module, used for logging
var logger = require('winston');
// CognicityServer module, application logic and database interaction is handled here
var CognicityServer = require('./CognicityServer.js');
// Validation module, parameter validation functions
var Validation = require('./Validation.js');

// Read in config file from argument or default
var configFile = ( process.argv[2] ? process.argv[2] : 'config.js' );
var config = require( __dirname + path.sep + configFile );

// Express application instance
var app = express();

// Logging
// Configure custom File transport to write plain text messages
var logPath = ( config.logger.logDirectory ? config.logger.logDirectory : __dirname );
// Check that log file directory can be written to
try {
	fs.accessSync(logPath, fs.W_OK);
} catch (e) {
	console.log( "Log directory '" + logPath + "' cannot be written to"  );
	throw e;
}
logPath += path.sep;
logPath += config.instance + ".log";

logger
	.add(logger.transports.File, {
		filename: logPath, // Write to projectname.log
		json: false, // Write in plain text, not JSON
		maxsize: config.logger.maxFileSize, // Max size of each file
		maxFiles: config.logger.maxFiles, // Max number of files
		level: config.logger.level // Level of log messages
	})
	// Console transport is no use to us when running as a daemon
	.remove(logger.transports.Console);

// Handle postgres idle connection error (generated by RDS failover among other possible causes)
pg.on('error', function(err) {
	logger.error('Postgres connection error: ' + err);

	logger.info('Attempting to reconnect at intervals');

	var reconnectionAttempts = 0;
	var reconnectionFunction = function() {
		// Try and reconnect
		pg.connect(config.pg.conString, function(err, client, done){
			if (err) {
				reconnectionAttempts++;
				if (reconnectionAttempts >= config.pg.reconnectionAttempts) {
					// We have tried the maximum number of times, exit in failure state
					logger.error( 'Postgres reconnection failed' );
					logger.error( 'Maximum reconnection attempts reached, exiting' );
					exitWithStatus(1);
				} else {
					// If we failed, try and reconnect again after a delay
					logger.error( 'Postgres reconnection failed, queuing next attempt for ' + config.pg.reconnectionDelay + 'ms' );
					setTimeout( reconnectionFunction, config.pg.reconnectionDelay );
				}
			} else {
				// If we succeeded server will begin to respond again
				logger.info( 'Postgres connection re-established' );
			}
		});
	};
	reconnectionFunction();
});

// Verify DB connection is up
pg.connect(config.pg.conString, function(err, client, done){
	if (err){
		logger.error("DB Connection error: " + err);
		logger.error("Fatal error: Application shutting down");
		done();
		exitWithStatus(1);
	}
});

// Create instances of CognicityServer and Validation
var server = new CognicityServer(config, logger, pg); // Variable needs to be lowercase or jsdoc output is not correctly linked

// Winston stream function we can plug in to express so we can capture its logs along with our own
var winstonStream = {
    write: function(message, encoding){
    	logger.info(message.slice(0, -1));
    }
};

if ( config.compression ) {
	// Enable gzip compression using defaults
	app.use( express.compress() );
}

// Setup express logger
app.use( morgan('combined', { stream : winstonStream } ) );

// Redirect http to https
app.use(function redirectHTTP(req, res, next) {
	if (config.redirectHTTP && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'].toLowerCase() === 'http') {
	 return res.redirect('https://' + req.headers.host + req.url);
	}
  next();
});

// Static file server
//app.use(app.router);
app.use('/'+config.url_prefix, express.static(config.public_dir));

// Robots.txt from root
app.use('/robots.txt', express.static(config.robots));

// Enable CORS for data streams
app.all('/'+config.url_prefix+'/data/*', function(req, res, next){
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "X-Requested-With");
	next();
});

// Language detection based on client browser
app.get(['/', '/'+config.root_redirect], function(req, res){
	if (req.acceptsLanguages(config.languages.locale) !== false){
		res.redirect('/'+config.root_redirect+'/'+config.languages.locale);
	}
	else {
		res.redirect('/'+config.root_redirect+'/'+config.languages.default);
	}
});

if (config.data === true){

	// Depreciate data API v1
	app.get('/'+config.url_prefix+'/data/api/v1*',function(req, res, next){
		res.setHeader('Cache-Control','max-age=60');
		res.redirect(301, '/'+config.url_prefix+'/data/api/v2'+req.params[0]);
	});

	app.get( new RegExp('/'+config.url_prefix+'/data/api/v2/.*'), function(req, res, next){
		// See if we've got a cache hit on the request URL
		var cacheResponse = cache.get(req.originalUrl);
		// Render the cached response now or let express find the next matching route
		if (cacheResponse) writeResponse(res, cacheResponse);
		else next();
	});

	// Data route for reports
	app.get('/'+config.url_prefix+'/data/api/v2/reports/confirmed', function(req, res, next){
		// Construct options
		var options = {
			start: Math.floor(Date.now()/1000 - config.api.time_window),
			end: Math.floor(Date.now()/1000), // now
			limit: config.pg.limit,
			tbl_reports: config.pg.tbl_reports
		};

		server.getReports(options, function(err, data){
			if (err) {
				next(err);
			} else {
				// Prepare the response data, cache it, and write out the response
				var responseData = prepareResponse(res, data[0], req.query.format);
				cacheTemporarily(req.originalUrl, responseData);
				writeResponse(res, responseData);
			}
		});
	});

	// Data Route for individual reports
	app.get('/'+config.url_prefix+'/data/api/v2/reports/confirmed/:id', function(req, res, next){
		// Construct internal options
		var options = {
			id: Number(req.params.id),
			tbl_reports: config.pg.tbl_reports
		};

		// Validate parameter
		if ( !Validation.validateNumberParameter(options.id, 0) ) {
			next( createErrorWithStatus("'id' parameter is not valid, it must be an integer greater than 1", 400) );
			return;
		}

		server.getReport(options, function(err, data){
			if (err) {
				next(err);
			} else {
				// Prepare the response data, cache it, and write out the response
				var responseData = prepareResponse(res, data[0], req.query.format);
				cacheTemporarily(req.originalUrl, responseData);
				writeResponse(res, responseData);
			}
		});
	});

	// Data route for IoT floodsensor readings
	app.get('/'+config.url_prefix+'/data/api/v2/iot/smartsensors', function(req, res, next){
		// Construct Options
		var options = {
			start: Math.floor(Date.now()/1000 - config.api.floodgauges.time_window),
			end: Math.floor(Date.now()/1000), // now
			tbl_sensor_data: config.pg.iot_floodsensors.sensor_data,
			tbl_sensor_metadata: config.pg.iot_floodsensors.sensor_metadata
		};

		server.getFloodsensors(options, function(err, data){
			if (err) {
				next(err);
			} else {
				// Prepare the response data, cache it, and write out the response
				var responseData = prepareResponse(res, data[0], req.query.format);
				cacheTemporarily(req.originalUrl, responseData);
				writeResponse(res, responseData);
			}
		});
	});


	// Data route for floodgauge readings
	app.get('/'+config.url_prefix+'/data/api/v2/infrastructure/floodgauges', function(req, res, next){
		// Get last segment of path - e.g. 'waterways' in '.../infrastructure/waterways'
		var infrastructureName = req.path.split("/").slice(-1)[0];
		// Construct Options
		var options = {
			start: Math.floor(Date.now()/1000 - config.api.floodgauges.time_window),
			end: Math.floor(Date.now()/1000), // now
			tbl_floodgauges: config.pg.infrastructure_tbls[infrastructureName]
		};

		server.getFloodgauges(options, function(err, data){
			if (err) {
				next(err);
			} else {
				// Prepare the response data, cache it, and write out the response
				var responseData = prepareResponse(res, data[0], req.query.format);
				cacheTemporarily(req.originalUrl, responseData);
				writeResponse(res, responseData);
			}
		});
	});

	app.get( new RegExp('/'+config.url_prefix+'/data/api/v2/infrastructure/.*'), function(req, res, next){
		// Get last segment of path - e.g. 'waterways' in '.../infrastructure/waterways'
		var infrastructureName = req.path.split("/").slice(-1)[0];
		// Construct options object for server query
		var options = {
			infrastructureTableName: config.pg.infrastructure_tbls[infrastructureName]
		};
		// Validate parameter exists; as it's config driven we don't do more than this and assume that the config is correct
		if (!options.infrastructureTableName){
			next( createErrorWithStatus("Infrastructure type is not valid", 400) );
			return;
		}
		// Fetch the infrastructure data from the DB
		server.getInfrastructure(options, function(err, data){
			if (err) {
				next(err);
			} else {
				// Prepare the response data, cache it, and write out the response
				var responseData = prepareResponse(res, data[0], req.query.format);
				cachePermanently(req.originalUrl, responseData);
				writeResponse(res, responseData);
			}
		});
	});

	// FloodWatch API
	if (config.api.floodwatch === true){
		// Data route for JSON data of reports by city last hour
		app.get('/'+config.url_prefix+'/data/api/v2/floodwatch/reports/', function(req,res,next){
			// Prepare area name
			var area_name = null;
			if (req.query.area_name){
				area_name = req.query.area_name;
			}
			// Query options
			var options = {
				tbl_reports: config.pg.tbl_reports,
				polygon_layer: config.pg.aggregate_levels.city,
				start: Math.floor(Date.now()/1000 - config.api.time_window),
				end: Math.floor(Date.now()/1000),
				limit:config.pg.limit,
				area_name: area_name
		};
			// Fetch the data
			server.getReportsByArea(options, function(err, data){
				if (err){
					next(err);
				}
				else {
					// Prepare response data, cache and write out response
					var responseData = prepareResponse(res, data[0], req.query.format);
					cacheTemporarily(req.originalUrl, responseData);
					writeResponse(res, responseData);
				}
			});
		});
	}
}

/**
 * Store the response in the memory cache with no timeout
 * @param {string} cacheKey Key for the cache entry
 * @param {object} data Data to store in the cache
 */
function cachePermanently(cacheKey, data){
	cache.put(cacheKey, data);
}

/**
 * Store the response the memory cache with timeout
 * @see {@link config} property cache_timeout
 * @param {string} cacheKey Key for the cache entry
 * @param {object} data Data to store in the cache
 */
function cacheTemporarily(cacheKey, data){
	cache.put(cacheKey, data, config.cache_timeout);
}

// 404 handling
app.use(function(req, res, next){
  res.status(404).send('Error 404 - Page not found');
});

/**
 * Create a JavaScript Error object with the supplied status
 * @param {string} message Error message
 * @param {number} status HTTP error status code
 * @returns {Error} New Error object
 */
function createErrorWithStatus(message, status) {
	var err = new Error(message);
	err.status = status;
	return err;
}

// Error handler function
app.use(function(err, req, res, next){
	// TODO Uncomment this code when the client can cope with error status codes
	logger.error( "Express error: " + err.status + ", " + err.message + ", " + err.stack );
//	res.status( err.status || 500 );
//	res.send( err.message );

	// TODO Delete this code when the client can cope with error status codes
	writeResponse( res, { code: 204, headers: {}, body: null } );
});

/**
 * @typedef {object} HttpResponse
 * @property {number} code HTTP Response code
 * @property {object} headers Object containing HTTP headers as name/value pairs
 * @property {string} headers.(name) HTTP header name
 * @property {string} headers.(value) HTTP header value
 * @property {string} body Response body
 */

/**
 * Prepare the response data for sending to the client.
 * Will optionally format the data as topojson if this is requested via the 'format' parameter.
 * Returns a response object containing everything needed to send a response which can be sent or cached.
 *
 * @param {object} res The express 'res' response object
 * @param {object} data The data we're going to return to the client
 * @param {string=} format Format parameter for the response data; either nothing or 'topojson'
 * @returns {HttpResponse} HTTP response object
 */
function prepareResponse(res, data, format){
	var responseData = {};

	if (format === 'topojson' && data.features){
		// Convert to topojson and construct the response object
		var topology = topojson.topology({collection:data},{"property-transform":function(object){return object.properties;}});

		responseData.code = 200;
		responseData.headers = {"Content-type":"application/json"};
		responseData.body = JSON.stringify(topology, "utf8");
	} else {
		// Construct the response object in JSON format or an empty (but successful) response
		if (data) {
			responseData.code = 200;
			responseData.headers = {"Content-type":"application/json"};
			responseData.body = JSON.stringify(data, "utf8");
		} else {
			responseData.code = 204;
			responseData.headers = {};
			responseData.body = null;
		}
	}

	return responseData;
}

/**
 * Write a response object to the client using express.
 * Will write the response code, response headers and response body, and then end the response stream.
 *
 * @param {object} res Express 'res' response object
 * @param {HttpResponse} responseData HTTP response object
 */
function writeResponse(res, responseData) {
	res.writeHead( responseData.code, responseData.headers );
	res.end( responseData.body );
}

// Use the PORT environment variable (e.g. from AWS Elastic Beanstalk) or use 8081 as the default port
logger.info( "Application starting, listening on port " + config.port );
app.listen(config.port);

// FIXME This is a workaround for https://github.com/flatiron/winston/issues/228
// If we exit immediately winston does not get a chance to write the last log message.
// So we wait a short time before exiting.
function exitWithStatus(exitStatus) {
	logger.info( "Exiting with status " + exitStatus );
	setTimeout( function() {
		process.exit(exitStatus);
	}, 500 );
}

// Catch kill and interrupt signals and log a clean exit status
process.on('SIGTERM', function() {
	logger.info('SIGTERM: Application shutting down');
	exitWithStatus(0);
});
process.on('SIGINT', function() {
	logger.info('SIGINT: Application shutting down');
	exitWithStatus(0);
});

// Catch unhandled exceptions, log, and exit with error status
process.on('uncaughtException', function (err) {
	logger.error('uncaughtException: ' + err.message + ", " + err.stack);
	logger.error("Fatal error: Application shutting down");
	exitWithStatus(1);
});
