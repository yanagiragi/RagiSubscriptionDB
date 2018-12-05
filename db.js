const fs = require('fs')
const ipc = require('node-ipc')
const EventEmitter = require('events').EventEmitter
const { createLogger, format, transports } = require('winston')
const Transport = require('winston-transport')
const { combine, timestamp, label, printf } = format
const blessed = require('blessed')

const uid = 'RagiDB.server-6563349053925304016'

/*
*	存放資料的檔案
*	path to container.json
*/

const dataPath = './data/container.json'
var container = JSON.parse(fs.readFileSync(dataPath))

function CreateHashId(typeId, nickname, entry)
{
	return `${container.types[typeId]}_${nickname}_${entry.href}_${entry.img}`
}

function CreateHashTable()
{
	let hash = []
	container.container.map((e, index) => {
		e.list.map((e2, index2) => {
			let hashId = CreateHashId(e.typeId, e.nickname, e2)
			hash.push(hashId)
		})
	})
	console.log(`Mapping ${hash.length} hashes.`)
	return hash
}

var hashTable = CreateHashTable()

/*
*	dirty 代表是否記憶體中的檔案有更改過，
*	如果有更改過，則代表該把變更寫回檔案中
*/

var dirty = false

/*
*	taskQueue 紀錄接受到的工作，並依照工作類型分給不同函式完成它
*
*	readQueue 紀錄讀取的請求，一般來說會請求的主要就是瀏覽器端 (RagiSubscriptionWeb)
*	因為沒有瀏覽器的資料呈現不需要太即時，因此沒有同步等當前 taskQueue 處理完才處理 readQ 請求
*/
	
var taskQueue = [] // task format = [ function , data ]
var readQueue = [] // read format = [ function , socket ]
	
	

/*
*	設定 Screen 設定 (Update Screen 在後面)
*/

	// Create a screen object.
	var screen = blessed.screen({
	   smartCSR: true,
	   fullUnicode: true
	});
	
	screen.title = uid;
	
	// Create a box perfectly centered horizontally and vertically.
	var queueBox = blessed.box({
		top: 'top',
		left: 'left',
		width: '100%',
		height: '5%',
		align: 'center',
		valign: 'center',
		content: '{bold}Queue{/bold}: null',
		tags: true,
		border: {
			type: 'line'
		}
	})
	
	var logBox = blessed.box({
		top: '5%',
		left: 'left',
		width: '100%',
		height: '95%',
		content: 'Start RagiDB',
		tags: true,
		scrollable: true,
		border: {
			type: 'line'
			}
	})	
	
	screen.append(queueBox)
	screen.append(logBox)
	logBox.focus()
	
	// Quit on Escape, q, or Control-C.
	screen.key(['escape', 'q', 'C-c'], function(ch, key) {
		return process.exit(0);
	});
	

	/*
	*	更新 Screen 設定
	*/
		
	var logBuffer = []
	const maxLogLength = 50
	var lastSaveDate = new Date()

	setInterval(function(){ 
	
		queueBox.setContent(`{bold}RagiDB{/bold} | {bold}Task{/bold}[${taskQueue.length}], {bold}Read{/bold}[${readQueue.length}], {bold}Last Save{/bold}: ${lastSaveDate} | [${hashTable.length}]`); 
			
		logBox.content = ''

		while(logBuffer.length > maxLogLength)
			logBuffer.splice(0, 1)

		for(let i = 0; i < logBuffer.length; ++i){
			if(i == 0) logBox.setContent(logBuffer[0].message)
			else logBox.setContent( logBox.content + '\n' + logBuffer[i].message )
		}
	
		screen.render(); 
	
	}, 1000)


/*
*	設定 Logger 的格式
*/

const myFormat = printf(info => {
	return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`
})



/*
*	專案使用的三個 Level: 
*		1. debug: 所有資訊 
*		2. info : 只顯示必要資訊 (給 Console 介面看的)
*		3. error: 重大錯誤 (亦會顯示在 Console)
*/

class YrCustomTransport extends Transport {
	constructor(opts) { 
		super(opts)
	}

	log(info, callback) {
		setImmediate(() => {
			this.emit('logged', info)
		})

		logBuffer.push(info)

		callback()
	}
};

const logger = createLogger({
	format: combine(
		label({ label: 'RagiDB' }),
		timestamp(),
		myFormat
	),
	transports: [
		//new transports.Console({ level: 'info' }),
		new transports.File({ filename: 'RagiDB.log', level: 'debug'}),
		new YrCustomTransport({ level: 'info' })
		// level 設定 debug 代表 debug 以上的 level 的 log 通通都會顯示
	]
})



/*
*	設定 IPC Server 的設定
*
*	config.id 為 連接此 Server 的 key， Client 那邊的字串必須與這邊相同
*
*/

// Setup ipc
ipc.config.id = uid
ipc.config.retry = 1500
ipc.config.silent = true


/*
*	設定 IPC Server 的 API 並啟動 IPC Server
*
*	RagiDB.Noticed: 單一資料被閱讀時會呼叫這個API
*	RagiDB.Add: 增加資料時會呼叫這個API，注意這筆資料不一定會是新的資料，而是會由這個API去做檢查是否需要添加新資料到 Database 資料中
*	RagiDB.Data: 閱讀請求，如果 Dirty 被拉起來，就直接吐回記憶體中的 Database 資料並請求存檔。若未被拉起來，亦土回記憶體內的 Database 資料作為 Cache 加速。
*/

// set up APIs
ipc.serve(() => {
	ipc.server.on('connect', () => {
		logger.log({
			level: 'debug',
			message: `client connected.`
		})
	})
	ipc.server.on('RagiDB.Noticed', message => {
		taskQueue.push([NoticeEntry, message])
	})
	ipc.server.on('RagiDB.Add', message => {
		taskQueue.push([Add, message])
	})
	ipc.server.on('RagiDB.Data', (message, socket) => {
		readQueue.push([ReadDB, socket])
	})
	ipc.server.on('socket.disconnected', (socket, destroyedSocketID) => {
		logger.log({
			level: 'debug',
			message: `client<${destroyedSocketID}> connected.`
		})
	})
});

ipc.server.start();

/*
*	設定 event 的設定
*
*	我的作法為 當一個 IPC Server 收到任何請求時，他都會把請求丟到 Queue 中 (分為 taskQueue 以及 readQueue )
*
*	接著 按照時間 dequeue 出請求，根據不同的類型 發出不同的 event 來處理當前的請求
*
*/

// Setup Event Handlers

const event = new EventEmitter()

event.on('RagiDB.DealAction.Task', () => {
	
	// get first task
	// action: function 型態
	// param: list 型態 (內容隨 action 而不同)
	let [ action, param ] = taskQueue[0]
	
	logger.log({
		level: 'debug',
		message: `Dequeue Event: <${action.name}, ${param[0]}, ${param[1]}>`
	})

	// dequeue
	taskQueue.splice(0,1) 

	action(param)
});

// 此 Event 只有在已經確認為 Dirty 後才會被發出
event.on('RagiDB.DealAction.Save', () => {
	
	lastSaveDate = new Date()

	logger.log({
		level: 'info',
		message: 'Confirm Dirty, Save'
	})
	
	SaveDB();
});

event.on('RagiDB.DealAction.Read', () => {
	
	logger.log({
		level: 'debug',
		message: 'Dealing Read Requests, ' + (dirty ? 'Using Cache' : "Remain Same")
	})

	// 如果記憶體與檔案內容不一致，請求存檔
	/*if(dirty)
	{
		event.emit('RagiDB.DealAction.Save')
	}*/
	
	// Maybe it is no so necessarily to save file so soon
	// Try let dirty checker (line 202) to save

	// action 本身不重要，只是為了資料格式統一
	// socket 為連線對象，因為這是唯一需要像 client 傳送資料的地方
	// 所以只有這裡有 emit 事件給 client
	let [ action, socket ] = readQueue[0]
	
	// dequeue
	readQueue.splice(0,1)
	
	ipc.server.emit(
		socket,
		'recv',
		container // 記憶體中的 Database 資料
	)

});

// Setup Event Loops
setInterval(function(){
	if(taskQueue.length > 0)
		event.emit('RagiDB.DealAction.Task');
}, 10)

setInterval(function(){
	if(readQueue.length > 0)
		event.emit('RagiDB.DealAction.Read');
}, 100 * 0.5)

setInterval(function(){
	if(dirty)
		event.emit('RagiDB.DealAction.Save');
}, 1000 * 10)


// Implemented functions

function ReadDB()
{
	container = JSON.parse(fs.readFileSync(dataPath))
}

function SaveDB()
{
	if(dirty){
		try{
			fs.writeFileSync(dataPath, JSON.stringify(container, null, 4))
		}
		catch(err){
			logger.log({
				level: 'error',
				message: `Error when writing file, error=<${err.message}>`
			})
			
			return
		}
		
		logger.log({
			level: 'info',
			message: 'Saving File Done, Restore Dirty to Clean'
		})

		// Restore dirty flag
		dirty = false
	}
}



/*
*	Params: 
*		containerId: container.container 中的 Id
*	Return
*		index: container.container 中的 Index
*
*	目的: 因為 Id 並非照順序排且可能會用跳的
*	
*	Examples:
*
*	60	
*		typeId	22
*		nickname	"鬼月あるちゅ SearchList"
*		list	[…]
*		id	60
*	61	
*		typeId	20
*		nickname	"アルノサージュ SearchList"
*		list	[…]
*		id	62
*
*/
function MapContainerIdToIndex(containerId)
{
	let isFound = false
	let index = -1
	
	for(let i = 0; i < container.container.length; ++i)
	{
		// use '==' instead of '===' to handle old id type is string, however new id type is integer
		if(container.container[i].id == containerId){
			if(!isFound){
				isFound = true
				index = i
			}
			else{
				logger.log({
					level: 'error',
					message: `Duplicated Id Found: <${containerId || null}>`
				})
				index = -1
				break
			}
		}
	}

	return index
}

/*
*	Params: 
*		containerId: container.container 中的 Index
*		listId: container.container[index].list 的 Index
*
*/

function NoticeEntry([containerId, listId])
{	
	const realContainerId = MapContainerIdToIndex(containerId)

	// 如果此 Entry 存在
	if(realContainerId != -1 && container.container[realContainerId] && container.container[realContainerId].list[listId]){
		
		container.container[realContainerId].list[listId].isNoticed = true;
		
		dirty = true;
		
		logger.log({
			console: 'true',
			level: 'info',
			message: `Read ContainerId<${realContainerId}> & ListId<${listId}>, title = ${container.container[realContainerId].list[listId].title}`
		});

	}
	else{

		logger.log({
			level: 'error',
			message: `Error with ContainerId<${realContainerId}> & ListId<${listId}>`
		});

	}
}


/*
*	Params: 
*		containerId: container.container 中的 Index
*		data: entry 的資料
*
*	Return:
*
*		是否存在 (bool)
*
*/

function CheckExisted(containerId, data)
{
	let version = 2

	var existed = false

	if(version === 1){
	
		if(container.container[containerId] && container.container[containerId].list){
			
			for(var entryId in container.container[containerId].list){
			
				let entry = container.container[containerId].list[entryId]
				let match = (
					entry.title == data.title && 
					entry.img == data.img &&
					entry.href == data.href
				)
			
			if(match){ // early break
				existed = true
					break
				}
			}
		}
	}
	else if(version === 2){
		let typeId = container.container[containerId].typeId
		let nickname = container.container[containerId].nickname
		let hashId = CreateHashId(typeId, nickname, data)
		existed = hashTable.indexOf(hashId) !== -1
	}

	return existed
}


/*
*	Params: 
*		containerType(string): 哪種類型的plugin的資料
*		nickname(string): 暱稱
*
*	E.g.:
*		
*		containerType: Baidu
*		nickname: MMD Teiba
*		代表它為 百度的 MMD 貼吧
*
*	Return:
*
*		它在 container.container 中的 Index (int)
*
*/

// Similar to MapContainerIdToIndex()
// May Need ReFactor?

function GetContainerId(containerType, nickname)
{
	let typeId = container.types.indexOf(containerType)
	var idx = 0

	for(idx = 0; idx < container.container.length; ++idx){
		if(container.container[idx].nickname == nickname && container.container[idx].typeId == typeId){
			break
		}
	}
	
	return idx >= container.container.length ? -1 : idx
}

/*
*	Params: 
*		containerType(string): 哪種類型的資料
*		nickname(string): 暱稱
*		data: entry 資料
*
*
*	如果此資料存在，那就略過
*
*	如果此資料不存在，加入這筆資料
*
*	如果此資料連 類型都不存在，新增此類型 & 加入這筆資料
*	
*/

function Validate(data)
{
	let isValid = false

	isValid = data && data.title && data.href && data.img

	return isValid
}

function Add([containerType, nickname, data])
{
	let containerId = GetContainerId(containerType, nickname)//container.types.indexOf(containerType)

	// 類型不存在，新增類型
	if(containerId == -1 || container.types[container.container[containerId].typeId] != containerType){
		
		logger.log({
			level: 'info',
			message: `mapping ${containerType} ${nickname} to ${containerId} Failed. Create new container.container`
		})

		var i;
		for(i = 0; i < container.types.length; ++i)
			if(container.types[i] == containerType)
				break

		container.container.push({
			"typeId": i,
			"nickname": nickname,
			"list": [],
			"id": parseInt(container.container[container.container.length - 1].id)  + 1
		})
		
		if ( i >= container.types.length ){
			container.types.push(containerType)
		}

		containerId = GetContainerId(containerType, nickname) 
	}

	let existed = CheckExisted(containerId, data)
	let isValid = Validate(data)
	
	if(isValid && !existed)
	{
		dirty = true;
		
		/*	取得要新增的 Entry 的 Id 應該是多少
		*
		* 	由於 此 Id 不一定會是 目前 list 的長度，所以用比較麻煩的方法取得
		*
		*	(即使手動刪出中間幾個 entry，id 還是會繼續 increment 下去，不會蓋到之前的資料)
		*/
		var lastDataInContainer = container.container[containerId].list[container.container[containerId].list.length - 1]
		
		// 如果剛剛才建立這類型，設定data.id = 0
		data.id = (lastDataInContainer) ? parseInt(lastDataInContainer.id) + 1 : 0
		
		container.container[containerId].list.push(data)

		let typeId = container.container[containerId].typeId
		let nickname = container.container[containerId].nickname
		let hashId = CreateHashId(typeId, nickname, data)
		hashTable.push(hashId)
		
		logger.log({
			level: 'info',
			message: `Add New Entry, title = <${data.title}>`
		});

	}
	else {
		if(existed) {
			logger.log({
				level: 'debug',
				message: `Entry existed, title = <${data.title}>`
			})
		}
		else {
			if(data) {
				logger.log({
					level: 'error',
					message: `Missing entry: <${data.title || null}, ${data.href || null}, ${data.img || null}, ${data.isNoticed || null}>`
				})
			}
			else {
				logger.log({
					level: 'error',
					message: `Missing entry: <${data || null}>`
				})
			}
		}
	}
}

