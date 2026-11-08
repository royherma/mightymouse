import ImageIO
import MobileCoreServices
import UIKit
import UniformTypeIdentifiers

/// The share sheet's own UI. A plain `UIViewController`, not
/// `SLComposeServiceViewController`: the stock compose box is built around a
/// text field and a "Post" button, and this surface needs a preview plus two
/// distinct verbs.
///
/// Two buttons rather than one button and a remembered toggle. Pasting into the
/// wrong window is recoverable; sending is not, so the irreversible verb is its
/// own visible choice on every share instead of hidden state the user has to
/// check first.
final class ShareViewController: UIViewController {
    private let credentials = Credentials()

    /// Whichever arrived first. Exactly one is non-nil by the time the buttons
    /// enable -- the activation rule caps the share at a single item.
    private var imageData: Data?
    private var imageMime: String?
    private var imageName: String = ""
    private var sharedText: String?

    private let card = UIView()
    private let thumbnail = UIImageView()
    private let textPreview = UILabel()
    private let destinationLabel = UILabel()
    private let pasteButton = UIButton(type: .system)
    private let sendButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let statusLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        buildLayout()
        setButtonsEnabled(false)
        loadSharedItem()
    }

    // MARK: - Layout

    private func buildLayout() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)

        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 20
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        // Literal, not AppConfig.appName: inside this target CFBundleDisplayName
        // is already "Send to MightyMouse" (it is the share sheet's row label),
        // so composing with it reads "Send to Send to MightyMouse".
        let title = UILabel()
        title.text = "Send to Mac"
        title.font = .preferredFont(forTextStyle: .headline)
        title.textAlignment = .center

        // Filled at load time from the App Group mirror. Left empty rather than
        // guessing: naming the wrong destination is worse than naming none,
        // because the whole point of this line is deciding whether to submit.
        destinationLabel.font = .preferredFont(forTextStyle: .subheadline)
        destinationLabel.textColor = .secondaryLabel
        destinationLabel.textAlignment = .center

        thumbnail.contentMode = .scaleAspectFit
        thumbnail.layer.cornerRadius = 12
        thumbnail.clipsToBounds = true
        thumbnail.isHidden = true

        textPreview.font = .preferredFont(forTextStyle: .body)
        textPreview.numberOfLines = 4
        textPreview.textColor = .label
        textPreview.isHidden = true

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2

        configure(pasteButton, title: "Paste", prominent: false)
        configure(sendButton, title: "Paste and send", prominent: true)
        pasteButton.addTarget(self, action: #selector(pasteTapped), for: .touchUpInside)
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            title, destinationLabel, thumbnail, textPreview,
            statusLabel, sendButton, pasteButton, cancel
        ])
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(4, after: title)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        card.addSubview(spinner)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 20),
            card.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 380),

            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),

            thumbnail.heightAnchor.constraint(lessThanOrEqualToConstant: 220),
            spinner.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: card.centerYAnchor)
        ])
    }

    private func configure(_ button: UIButton, title: String, prominent: Bool) {
        var config = prominent ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
        config.title = title
        config.cornerStyle = .large
        config.buttonSize = .large
        button.configuration = config
    }

    private func setButtonsEnabled(_ enabled: Bool) {
        pasteButton.isEnabled = enabled
        sendButton.isEnabled = enabled
    }

    // MARK: - Item loading

    private func loadSharedItem() {
        // The Mac writes its front app into the App Group on every context
        // change, so this is a read, not a round-trip -- the sheet must not wait
        // on the network to show what it is about to type into.
        if let host = SharedAppGroup.defaults.string(forKey: SharedAppGroup.hostNameKey), !host.isEmpty {
            destinationLabel.text = "→ \(host)"
        }

        guard
            let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let providers = item.attachments
        else {
            fail("Nothing to send")
            return
        }

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                loadImage(from: provider)
                return
            }
        }
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                loadText(from: provider, type: UTType.url.identifier)
                return
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                loadText(from: provider, type: UTType.plainText.identifier)
                return
            }
        }
        fail("That kind of item can't be sent")
    }

    private func loadImage(from provider: NSItemProvider) {
        spinner.startAnimating()
        provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { [weak self] item, _ in
            guard let self else { return }
            // Downscaled straight from the source, never through a full-size
            // UIImage: a burst screenshot decoded whole is what kills a share
            // extension, and it is killed without a crash log.
            let encoded: Data?
            if let url = item as? URL {
                encoded = Self.downscaledJPEG(from: url as CFURL)
            } else if let image = item as? UIImage {
                encoded = image.jpegData(compressionQuality: AppConfig.shareImageQuality)
            } else if let data = item as? Data {
                encoded = Self.downscaledJPEG(fromData: data)
            } else {
                encoded = nil
            }
            let name = (item as? URL)?.lastPathComponent ?? ""

            DispatchQueue.main.async {
                self.spinner.stopAnimating()
                guard let encoded, !encoded.isEmpty else {
                    self.fail("That image couldn't be read")
                    return
                }
                self.imageData = encoded
                self.imageMime = "image/jpeg"
                self.imageName = name
                self.thumbnail.image = UIImage(data: encoded)
                self.thumbnail.isHidden = false
                self.setButtonsEnabled(true)
            }
        }
    }

    private func loadText(from provider: NSItemProvider, type: String) {
        spinner.startAnimating()
        provider.loadItem(forTypeIdentifier: type, options: nil) { [weak self] item, _ in
            guard let self else { return }
            let text: String?
            if let url = item as? URL {
                text = url.absoluteString
            } else if let string = item as? String {
                text = string
            } else {
                text = nil
            }
            DispatchQueue.main.async {
                self.spinner.stopAnimating()
                guard let text, !text.isEmpty else {
                    self.fail("That item was empty")
                    return
                }
                self.sharedText = text
                self.textPreview.text = text
                self.textPreview.isHidden = false
                self.setButtonsEnabled(true)
            }
        }
    }

    /// `kCGImageSourceThumbnailMaxPixelSize` does the resize inside ImageIO, so
    /// the full-resolution bitmap never exists in this process.
    private static func downscaledJPEG(from url: CFURL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url, nil) else { return nil }
        return encode(source)
    }

    private static func downscaledJPEG(fromData data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return encode(source)
    }

    private static func encode(_ source: CGImageSource) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: AppConfig.shareImageMaxPixel
        ]
        guard
            let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: AppConfig.shareImageQuality)
    }

    // MARK: - Sending

    @objc private func pasteTapped() { send(submit: false) }
    @objc private func sendTapped() { send(submit: true) }

    @objc private func cancelTapped() {
        extensionContext?.cancelRequest(withError: NSError(domain: "com.mightymouse.share", code: 0))
    }

    private func send(submit: Bool) {
        setButtonsEnabled(false)
        spinner.startAnimating()
        statusLabel.text = nil

        var body: [String: Any] = ["submit": submit]
        if let imageData, let imageMime {
            body["image"] = imageData.base64EncodedString()
            body["mime"] = imageMime
            body["name"] = imageName
        } else if let sharedText {
            body["text"] = sharedText
        } else {
            fail("Nothing to send")
            return
        }

        Task {
            do {
                try await MacRelayClient.post(AppConfig.sharePath, credentials: credentials, body: body)
                await MainActor.run { self.extensionContext?.completeRequest(returningItems: nil) }
            } catch {
                await MainActor.run { self.fail(self.message(for: error)) }
            }
        }
    }

    /// Never a silent success: a share that vanished is indistinguishable from
    /// one that landed in the wrong app, and the user cannot check from here.
    private func message(for error: Error) -> String {
        switch error {
        case MacRelayClient.RelayError.noCredential:
            // Keychain status is shown inline while this path is unproven on
            // device: -34018 means the entitlement did not resolve, -25300
            // means the app never wrote the row. Same message otherwise.
            return "Can't read the pairing key (\(credentials.lastReadStatus))"
        case MacRelayClient.RelayError.noHost:
            return "Open MightyMouse once to find your Mac"
        default:
            return "Can't reach your Mac"
        }
    }

    private func fail(_ message: String) {
        spinner.stopAnimating()
        statusLabel.text = message
        statusLabel.textColor = .systemRed
        setButtonsEnabled(imageData != nil || sharedText != nil)
    }
}
