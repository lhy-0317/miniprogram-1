const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const { questionId, isCorrect, answerTime, questionIndex } = event
  
  try {
    const recordData = {
      _openid: wxContext.OPENID,
      questionId: questionId || null,
      questionIndex: questionIndex || null,
      isCorrect: isCorrect || false,
      answerTime: answerTime || 0,
      createTime: db.serverDate()
    }
    
    const result = await db.collection('quiz_records').add({
      data: recordData
    })
    
    if (isCorrect) {
      await updateUserQuizCount(wxContext.OPENID)
    }
    
    return {
      success: true,
      data: {
        recordId: result._id,
        ...recordData
      }
    }
  } catch (err) {
    console.error('提交答题记录失败', err)
    return {
      success: false,
      error: err.message
    }
  }
}

async function updateUserQuizCount(openid) {
  try {
    const userResult = await db.collection('users').where({
      _openid: openid
    }).get()
    
    if (userResult.data.length > 0) {
      const user = userResult.data[0]
      const currentCount = user.quizCount || 0
      
      await db.collection('users').doc(user._id).update({
        data: {
          quizCount: currentCount + 1,
          updateTime: db.serverDate()
        }
      })
    }
  } catch (err) {
    console.error('更新用户答题数失败', err)
  }
}
