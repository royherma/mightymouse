plugins {
    id("com.android.application")
}

android {
    namespace = "com.mightymouse.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.mightymouse.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("upload") {
            System.getenv("MM_ANDROID_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("MM_ANDROID_STORE_PASSWORD")
            keyAlias = System.getenv("MM_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("MM_ANDROID_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (System.getenv("MM_ANDROID_KEYSTORE") != null) signingConfig = signingConfigs.getByName("upload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
