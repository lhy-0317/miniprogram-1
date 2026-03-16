const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { count = 5 } = event
  
  try {
    const result = await db.collection('quiz_questions').get()
    
    let questions = result.data
    
    if (questions.length > count) {
      questions = shuffleArray(questions).slice(0, count)
    }
    
    return {
      success: true,
      data: questions,
      total: questions.length
    }
  } catch (err) {
    console.error('获取题目失败', err)
    return {
      success: false,
      error: err.message,
      data: []
    }
  }
}

function shuffleArray(array) {
  const newArray = [...array]
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[newArray[i], newArray[j]] = [newArray[j], newArray[i]]
  }
  return newArray
}
